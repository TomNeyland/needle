import * as vscode from 'vscode';
import { startEmbeddingServer } from './server';
import { updateFileEmbeddings } from './indexer';
import { parseHTMLSymbols, symbolIsTooSmall, generateFingerprint, getSymbolContextWithParents, extractCenteredCode } from '../utils/embeddingUtils';
import * as path from 'path';
import { FlattenedSymbol } from './indexer';
import { global } from '../extension';

const MAX_CODE_CHUNK_SIZE = 1000;

/**
 * Forces a regeneration of the embeddings cache file
 */
export async function regenerateEmbeddings(exclusionPattern: string = ''): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    throw new Error('No workspace folder open.');
  }

  console.log('[Search++] Starting full re-indexing...');

  // Ensure the server is ready
  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    throw new Error('Failed to start embedding server.');
  }

  // Re-index the workspace and collect documents
  const documents: { document: string; metadata: any }[] = [];
  const files = await vscode.workspace.findFiles(
    '**/*', // Include all files
    '**/{node_modules,.*}/**' // Exclude node_modules and hidden directories
  );

  for (const file of files) {
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
        const code = extractCenteredCode(doc, symbol.range, MAX_CODE_CHUNK_SIZE);
        const fingerprint = generateFingerprint(code);

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

  console.log(`[Search++] Collected ${documents.length} documents for re-embedding.`);
  if (documents.length > 0) {
    await updateFileEmbeddings(documents); // Send all documents to the backend
    console.log('[Search++] Successfully re-embedded the entire workspace.');
  } else {
    console.log('[Search++] No documents to re-embed.');
  }
}