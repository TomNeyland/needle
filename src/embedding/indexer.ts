import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getSymbolContextWithParents, generateFingerprint, symbolIsTooSmall, EmbeddedChunk } from '../utils/embeddingUtils';
import { startEmbeddingServer } from './server';
import { global } from '../extension';

const EMBEDDING_FILE = 'searchpp.embeddings.json';
const PARALLEL_EMBED_LIMIT = 500;

function isFileInAHiddenFolder(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  return segments.some(segment => segment.startsWith('.') && segment.length > 1);
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

type FlattenedSymbol = { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] };

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
    '**/{node_modules,\\.*/}/**'
  );

  let embeddedChunks: EmbeddedChunk[] = [];
  const processedFingerprints = new Set<string>();

  for (const file of files) {
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

      const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): FlattenedSymbol[] =>
        symbols.flatMap(sym => [{ symbol: sym, parents }, ...flatten(sym.children, [...parents, sym])]);

      const flattened = flatten(symbols).sort((a: FlattenedSymbol, b: FlattenedSymbol) =>
        a.symbol.range.start.line - b.symbol.range.start.line
      );

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

        const codeInputs = batch.map(({ symbol }) => doc.getText(symbol.range));
        const fingerprints = codeInputs.map(code => generateFingerprint(code));

        const filtered: {
          code: string;
          symbol: vscode.DocumentSymbol;
          parents: vscode.DocumentSymbol[];
          fingerprint: string;
        }[] = [];

        for (let j = 0; j < batch.length; j++) {
          const { symbol, parents } = batch[j];
          const fingerprint = fingerprints[j];
          if (processedFingerprints.has(fingerprint)) continue;
          processedFingerprints.add(fingerprint);
          filtered.push({ code: codeInputs[j], symbol, parents, fingerprint });
        }

        if (filtered.length === 0) continue;

        const codesToSend = filtered.map(item => item.code);
        const embeddings = await getLocalEmbeddingsBatch(codesToSend);

        filtered.forEach((item, idx) => {
          embeddedChunks.push({
            embedding: embeddings[idx],
            code: item.code,
            filePath: file.fsPath,
            lineStart: item.symbol.range.start.line,
            lineEnd: item.symbol.range.end.line,
            fingerprint: item.fingerprint,
            context: getSymbolContextWithParents(item.symbol, item.parents, doc)
          });
        });
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

    const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): FlattenedSymbol[] =>
      symbols.flatMap(sym => [{ symbol: sym, parents }, ...flatten(sym.children, [...parents, sym])]);

    const flattened = flatten(documentSymbols).sort((a: FlattenedSymbol, b: FlattenedSymbol) =>
      a.symbol.range.start.line - b.symbol.range.start.line
    );

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

    console.log(`[Search++] Re-embedding ${nonOverlapping.length} symbols from ${doc.uri.fsPath}`);

    for (let i = 0; i < nonOverlapping.length; i += PARALLEL_EMBED_LIMIT) {
      const batch = nonOverlapping.slice(i, i + PARALLEL_EMBED_LIMIT);

      const codeInputs = batch.map(({ symbol }) => doc.getText(symbol.range));
      const fingerprints = codeInputs.map(code => generateFingerprint(code));

      const filtered: {
        code: string;
        symbol: vscode.DocumentSymbol;
        parents: vscode.DocumentSymbol[];
        fingerprint: string;
      }[] = [];

      for (let j = 0; j < batch.length; j++) {
        const { symbol, parents } = batch[j];
        const fingerprint = fingerprints[j];
        const existing = embeddedChunks.find(
          c => c.filePath === doc.uri.fsPath &&
               c.lineStart === symbol.range.start.line &&
               c.fingerprint === fingerprint
        );
        if (existing) continue;
        filtered.push({ code: codeInputs[j], symbol, parents, fingerprint });
      }

      if (filtered.length === 0) continue;

      const codesToSend = filtered.map(item => item.code);
      const embeddings = await getLocalEmbeddingsBatch(codesToSend);

      const updatedChunks = filtered.map((item, idx) => ({
        embedding: embeddings[idx],
        code: item.code,
        filePath: doc.uri.fsPath,
        lineStart: item.symbol.range.start.line,
        lineEnd: item.symbol.range.end.line,
        fingerprint: item.fingerprint,
        context: getSymbolContextWithParents(item.symbol, item.parents, doc)
      }));

      embeddedChunks = embeddedChunks.filter(chunk => chunk.filePath !== doc.uri.fsPath);
      embeddedChunks.push(...updatedChunks);
    }

    fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Search++ re-indexed ${doc.uri.path}`);
    console.log(`[Search++] Saved updated embeddings for ${doc.uri.fsPath}`);
  }, null, context.subscriptions);
}
