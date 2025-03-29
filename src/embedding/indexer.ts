import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getSymbolContextWithParents, generateFingerprint, symbolIsTooSmall, EmbeddedChunk, parseHTMLSymbols } from '../utils/embeddingUtils';
import { startEmbeddingServer } from './server';
import { global } from '../extension';

const EMBEDDING_FILE = 'searchpp.embeddings.json';

function isFileInAHiddenFolder(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  return segments.some(segment => segment.startsWith('.') && segment.length > 1);
}

function isExcludedFileType(filePath: string): boolean {
  const excludedExtensions = ['.json', '.sqlite', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.exe'];
  // Allow .html files
  return excludedExtensions.some(ext => filePath.endsWith(ext));
}

export async function updateFileEmbeddings(documents: { document: string; metadata: any }[]): Promise<void> {
  console.log(`[Search++] Sending ${documents.length} documents to update_file_embeddings endpoint.`);
  const res = await fetch('http://localhost:8000/update_file_embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[Search++] API error ${res.status}: ${errorText}`);
    throw new Error(`[Search++] Failed to update embeddings: ${res.statusText}`);
  }

  console.log(`[Search++] Successfully updated embeddings.`);
}

type SymbolToEmbed = {
  code: string;
  fingerprint: string;
  filePath: string;
  symbol: vscode.DocumentSymbol;
  parents: vscode.DocumentSymbol[];
  doc: vscode.TextDocument;
};

export type FlattenedSymbol = { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] };

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function indexWorkspace(apiKey: string): Promise<void> {
  console.log('[Search++] Indexing full workspace...');

  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    vscode.window.showErrorMessage('Search++: Failed to start embedding server. Indexing will not work.');
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return;

  const files = await vscode.workspace.findFiles(
    '**/*', // Include all files
    '**/{node_modules,.*}/**' // Exclude node_modules and hidden directories
  );

  const processedFingerprints = new Set<string>();
  const documents: { document: string; metadata: any }[] = [];

  for (const file of files) {
    if (isFileInAHiddenFolder(file.fsPath) || isExcludedFileType(file.fsPath)) {
      console.log(`[Search++] Skipping excluded file: ${file.fsPath}`);
      continue;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const fileExtension = path.extname(file.fsPath);

      let symbols: FlattenedSymbol[] = [];
      if (fileExtension === '.html') {
        symbols = parseHTMLSymbols(doc);
      } else {
        const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', file
        );
        if (!documentSymbols) continue;

        const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): FlattenedSymbol[] =>
          symbols.flatMap(sym => [{ symbol: sym, parents }, ...flatten(sym.children, [...parents, sym])]);

        symbols = flatten(documentSymbols).sort((a, b) =>
          a.symbol.range.start.line - b.symbol.range.start.line
        );
      }

      const nonOverlapping: FlattenedSymbol[] = [];
      let lastEnd = -1;
      for (const item of symbols) {
        const { symbol } = item;
        const start = symbol.range.start.line;
        const end = symbol.range.end.line;
        if (start >= lastEnd && !symbolIsTooSmall(symbol, doc)) {
          nonOverlapping.push(item);
          lastEnd = end;
        }
      }

      for (const { symbol, parents } of nonOverlapping) {
        const code = doc.getText(symbol.range);
        const fingerprint = generateFingerprint(code);
        if (processedFingerprints.has(fingerprint)) continue;
        processedFingerprints.add(fingerprint);

        documents.push({
          document: code,
          metadata: {
            filePath: file.fsPath,
            start_line: symbol.range.start.line,
            end_line: symbol.range.end.line,
            language: fileExtension.replace('.', ''),
            kind: vscode.SymbolKind[symbol.kind],
            name: symbol.name,
            context: getSymbolContextWithParents(symbol, parents, doc)
          }
        });
      }
    } catch (err) {
      console.warn(`[Search++] Failed to index ${file.fsPath}`, err);
    }
  }

  console.log(`[Search++] Collected ${documents.length} documents for embedding.`);
  if (documents.length > 0) {
    await updateFileEmbeddings(documents);
  }
}

export function setupFileWatcher(context: vscode.ExtensionContext): void {
  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    console.log(`[Search++] File saved: ${doc.uri.fsPath}`);
    if (!vscode.workspace.workspaceFolders) return;

    const fileExtension = path.extname(doc.uri.fsPath);

    let flattened: FlattenedSymbol[] = [];
    if (fileExtension === '.html') {
      // Parse HTML symbols using our custom parser
      flattened = parseHTMLSymbols(doc);
    } else {
      // Use default symbol provider for other file types
      const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', doc.uri
      );
      if (!documentSymbols) return;

      const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): FlattenedSymbol[] =>
        symbols.flatMap(sym => [{ symbol: sym, parents }, ...flatten(sym.children, [...parents, sym])]);

      flattened = flatten(documentSymbols).sort((a, b) =>
        a.symbol.range.start.line - b.symbol.range.start.line
      );
    }

    const nonOverlapping: FlattenedSymbol[] = [];
    let lastEnd = -1;
    for (const item of flattened) {
      const { symbol } = item;
      const start = symbol.range.start.line;
      const end = symbol.range.end.line;
      if (start >= lastEnd && !symbolIsTooSmall(symbol, doc)) {
        nonOverlapping.push(item);
        lastEnd = end;
      }
    }

    const documents: { document: string; metadata: any }[] = [];
    for (const { symbol, parents } of nonOverlapping) {
      const code = doc.getText(symbol.range);
      const fingerprint = generateFingerprint(code);

      documents.push({
        document: code,
        metadata: {
          filePath: doc.uri.fsPath,
          start_line: symbol.range.start.line,
          end_line: symbol.range.end.line,
          language: fileExtension.replace('.', ''),
          kind: vscode.SymbolKind[symbol.kind],
          name: symbol.name,
          context: getSymbolContextWithParents(symbol, parents, doc)
        }
      });
    }

    console.log(`[Search++] Re-embedding ${documents.length} updated symbols from ${doc.uri.fsPath}`);
    if (documents.length === 0) return;

    await updateFileEmbeddings(documents);
    vscode.window.showInformationMessage(`Search++ re-indexed ${documents.length} chunks from ${path.basename(doc.uri.fsPath)}`);
    console.log(`[Search++] Successfully updated embeddings for ${doc.uri.fsPath}`);
  }, null, context.subscriptions);
}
