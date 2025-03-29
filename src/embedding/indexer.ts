import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getSymbolContextWithParents, generateFingerprint, symbolIsTooSmall, EmbeddedChunk, parseHTMLSymbols } from '../utils/embeddingUtils';
import { startEmbeddingServer } from './server';
import { global } from '../extension';

const EMBEDDING_FILE = 'searchpp.embeddings.json';
const PARALLEL_EMBED_LIMIT = 2048; // OpenAI's max input batch size

function isFileInAHiddenFolder(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  return segments.some(segment => segment.startsWith('.') && segment.length > 1);
}

function isExcludedFileType(filePath: string): boolean {
  const excludedExtensions = ['.json', '.sqlite', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.exe'];
  // Allow .html files
  return excludedExtensions.some(ext => filePath.endsWith(ext));
}

async function getLocalEmbeddingsBatch(codes: string[]): Promise<number[][]> {
  console.log(`[Search++] Sending embedding batch (size: ${codes.length})`);
  const res = await fetch('http://localhost:8000/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codes })
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error(`[Search++] Embedding API error ${res.status}: ${errorText}`);
    throw new Error(`[Search++] Failed to get embeddings: ${res.statusText}`);
  }

  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings;
}

type SymbolToEmbed = {
  code: string;
  fingerprint: string;
  filePath: string;
  symbol: vscode.DocumentSymbol;
  parents: vscode.DocumentSymbol[];
  doc: vscode.TextDocument;
};

type FlattenedSymbol = { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] };

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function indexWorkspace(apiKey: string): Promise<EmbeddedChunk[]> {
  console.log('[Search++] Indexing full workspace...');

  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    vscode.window.showErrorMessage('Search++: Failed to start embedding server. Indexing will not work.');
    return [];
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return [];

  const files = await vscode.workspace.findFiles(
    '**/*', // Include all files
    '**/{node_modules,.*}/**' // Exclude node_modules and hidden directories
  );

  const processedFingerprints = new Set<string>();
  const symbolsToEmbed: SymbolToEmbed[] = [];

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
        // Parse HTML symbols using htmlparser2
        symbols = parseHTMLSymbols(doc);
      } else {
        // Use default symbol provider for other file types
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

      // Process symbols (common logic for all file types)
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

        symbolsToEmbed.push({
          code,
          fingerprint,
          filePath: file.fsPath,
          symbol,
          parents,
          doc
        });
      }
    } catch (err) {
      console.warn(`[Search++] Failed to index ${file.fsPath}`, err);
    }
  }

  console.log(`[Search++] Collected ${symbolsToEmbed.length} symbols for embedding.`);

  // Batch everything globally now
  const batches = chunkArray(symbolsToEmbed, PARALLEL_EMBED_LIMIT);
  console.log(`[Search++] Embedding in ${batches.length} total batches.`);

  const embeddedChunks: EmbeddedChunk[] = [];

  const results = await Promise.all(batches.map(async (batch, i) => {
    const codes = batch.map(item => item.code);
    const embeddings = await getLocalEmbeddingsBatch(codes);

    return batch.map((item, idx) => ({
      embedding: embeddings[idx],
      code: item.code,
      filePath: item.filePath,
      lineStart: item.symbol.range.start.line,
      lineEnd: item.symbol.range.end.line,
      fingerprint: item.fingerprint,
      context: getSymbolContextWithParents(item.symbol, item.parents, item.doc)
    }));
  }));

  results.flat().forEach(chunk => embeddedChunks.push(chunk));

  return embeddedChunks;
}


export function setupFileWatcher(context: vscode.ExtensionContext): void {
  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    console.log(`[Search++] File saved: ${doc.uri.fsPath}`);
    if (!vscode.workspace.workspaceFolders) return;

    const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const embeddingPath = path.join(workspacePath, EMBEDDING_FILE);

    let embeddedChunks: EmbeddedChunk[] = [];
    if (fs.existsSync(embeddingPath)) {
      embeddedChunks = JSON.parse(fs.readFileSync(embeddingPath, 'utf-8'));
    }

    let flattened: FlattenedSymbol[] = [];
    const fileExtension = path.extname(doc.uri.fsPath);
    
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

    const filtered: SymbolToEmbed[] = [];
    for (const { symbol, parents } of nonOverlapping) {
      const code = doc.getText(symbol.range);
      const fingerprint = generateFingerprint(code);

      const existing = embeddedChunks.find(
        c => c.filePath === doc.uri.fsPath &&
             c.lineStart === symbol.range.start.line &&
             c.fingerprint === fingerprint
      );

      if (existing) {
        continue;
      }

      filtered.push({
        code,
        fingerprint,
        filePath: doc.uri.fsPath,
        symbol,
        parents,
        doc
      });
    }

    console.log(`[Search++] Re-embedding ${filtered.length} updated symbols from ${doc.uri.fsPath}`);
    if (filtered.length === 0) return;

    const codes = filtered.map(item => item.code);
    const embeddings = await getLocalEmbeddingsBatch(codes);

    const updatedChunks = filtered.map((item, idx) => ({
      embedding: embeddings[idx],
      code: item.code,
      filePath: item.filePath,
      lineStart: item.symbol.range.start.line,
      lineEnd: item.symbol.range.end.line,
      fingerprint: item.fingerprint,
      context: getSymbolContextWithParents(item.symbol, item.parents, item.doc)
    }));

    // Remove old chunks for this file
    embeddedChunks = embeddedChunks.filter(c => c.filePath !== doc.uri.fsPath);
    embeddedChunks.push(...updatedChunks);

    fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Search++ re-indexed ${updatedChunks.length} chunks from ${path.basename(doc.uri.fsPath)}`);
    console.log(`[Search++] Saved updated embeddings for ${doc.uri.fsPath}`);
  }, null, context.subscriptions);
}
