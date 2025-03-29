// src/embedding/indexer.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLocalEmbedding } from './embeddings';
import { EmbeddedChunk, generateFingerprint, getSymbolContextWithParents, symbolIsTooSmall } from '../utils/embeddingUtils';
import { startEmbeddingServer } from './server';
import { global } from '../extension';

const EMBEDDING_FILE = 'searchpp.embeddings.json';
const PARALLEL_EMBED_LIMIT = 500; // Configurable rate limit

function isFileInAHiddenFolder(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  return segments.some(segment => segment.startsWith('.') && segment.length > 1);
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
    '**/*.{ts,js,tsx,jsx,py,java,go,rs}',
    '**/{node_modules,\\.*/}/**' // TODO: Why does this work for dropping hidden folders?
  );
  let embeddedChunks: EmbeddedChunk[] = [];
  const processedFingerprints = new Set<string>();

  for (const file of files) {
    // skip files in hidden folders
    if (isFileInAHiddenFolder(file.fsPath)) {
      console.log(`[Search++] Skipping file in hidden folder: ${file.fsPath}`);
      continue;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', file
      );
      if (!symbols) continue;

      type FlattenedSymbol = { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] };
      const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): FlattenedSymbol[] =>
        symbols.flatMap(sym => [{ symbol: sym, parents }, ...flatten(sym.children, [...parents, sym])]);

      const flattened = flatten(symbols);
      flattened.sort((a, b) => a.symbol.range.start.line - b.symbol.range.start.line);

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

      for (let i = 0; i < nonOverlapping.length; i += PARALLEL_EMBED_LIMIT) {
        const batch = nonOverlapping.slice(i, i + PARALLEL_EMBED_LIMIT);
        await Promise.all(batch.map(async ({ symbol, parents }) => {
          const code = doc.getText(symbol.range);
          const fingerprint = generateFingerprint(code);
          if (processedFingerprints.has(fingerprint)) return;
          processedFingerprints.add(fingerprint);
          const context = getSymbolContextWithParents(symbol, parents, doc);
          const embedding = await getLocalEmbedding(code);

          if (embedding) {
            embeddedChunks.push({
              embedding,
              code,
              filePath: file.fsPath,
              lineStart: symbol.range.start.line,
              lineEnd: symbol.range.end.line,
              fingerprint,
              context
            });
          }
        }));
      }
    } catch (err) {
      console.warn(`[Search++] Failed to index ${file.fsPath}`, err);
    }
  }
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

    const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', doc.uri
    );
    if (!documentSymbols) return;

    const updatedChunks: EmbeddedChunk[] = [];

    const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): { symbol: vscode.DocumentSymbol, parents: vscode.DocumentSymbol[] }[] =>
      symbols.flatMap(sym => [{ symbol: sym, parents }, ...flatten(sym.children, [...parents, sym])]);

    const flattened = flatten(documentSymbols);
    flattened.sort((a, b) => a.symbol.range.start.line - b.symbol.range.start.line);

    const nonOverlapping: { symbol: vscode.DocumentSymbol, parents: vscode.DocumentSymbol[] }[] = [];
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

    console.log(`[Search++] Re-embedding ${nonOverlapping.length} symbols from ${doc.uri.fsPath}`);

    for (let i = 0; i < nonOverlapping.length; i += PARALLEL_EMBED_LIMIT) {
      const batch = nonOverlapping.slice(i, i + PARALLEL_EMBED_LIMIT);
      await Promise.all(batch.map(async ({ symbol, parents }) => {
        const code = doc.getText(symbol.range);
        const fingerprint = generateFingerprint(code);
        const existing = embeddedChunks.find(
          c => c.filePath === doc.uri.fsPath &&
               c.lineStart === symbol.range.start.line &&
               c.fingerprint === fingerprint
        );
        if (existing) {
          console.log(`[Search++] Skipping unchanged symbol '${symbol.name}'`);
          updatedChunks.push(existing);
          return;
        }
        const context = getSymbolContextWithParents(symbol, parents, doc);
        const embedding = await getLocalEmbedding(code);
        if (embedding) {
          updatedChunks.push({
            embedding,
            code,
            filePath: doc.uri.fsPath,
            lineStart: symbol.range.start.line,
            lineEnd: symbol.range.end.line,
            fingerprint,
            context
          });
        }
      }));
    }

    embeddedChunks = embeddedChunks.filter(chunk => chunk.filePath !== doc.uri.fsPath);
    embeddedChunks.push(...updatedChunks);
    fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Search++ re-indexed ${updatedChunks.length} chunks from ${path.basename(doc.uri.fsPath)}`);
    console.log(`[Search++] Saved updated embeddings for ${doc.uri.fsPath}`);
  }, null, context.subscriptions);
}
