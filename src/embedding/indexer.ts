import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getSymbolContextWithParents, generateFingerprint, symbolIsTooSmall, EmbeddedChunk, parseHTMLSymbols, extractCenteredCode, collectDocumentsFromWorkspace } from '../utils/embeddingUtils';
import { startEmbeddingServer, SERVER_URL } from './server';
import { global } from '../extension';
import { logger } from '../utils/logger';

const EMBEDDING_FILE = 'needle.embeddings.json';
const MAX_CODE_CHUNK_SIZE = 1000; // Maximum characters allowed in a code chunk

export async function updateFileEmbeddings(documents: { document: string; metadata: any }[]): Promise<void> {
  logger.info(`[Needle] Sending ${documents.length} documents to update_file_embeddings endpoint.`);
  const res = await fetch(`${SERVER_URL}/update_file_embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documents })
  });

  if (!res.ok) {
    const errorText = await res.text();
    logger.error(`[Needle] API error ${res.status}: ${errorText}`);
    throw new Error(`[Needle] Failed to update embeddings: ${res.statusText}`);
  }

  logger.info(`[Needle] Successfully updated embeddings.`);
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
  logger.info('[Needle] Indexing full workspace...');

  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    vscode.window.showErrorMessage('Needle: Failed to start embedding server. Indexing will not work.');
    return;
  }

  const documents = await collectDocumentsFromWorkspace();

  logger.info(`[Needle] Collected ${documents.length} documents for embedding.`);
  if (documents.length > 0) {
    await updateFileEmbeddings(documents);
  }
}

export function setupFileWatcher(context: vscode.ExtensionContext): void {
  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    logger.info(`[Needle] File saved: ${doc.uri.fsPath}`);
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
      const code = extractCenteredCode(doc, symbol.range, MAX_CODE_CHUNK_SIZE);
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

    logger.info(`[Needle] Re-embedding ${documents.length} updated symbols from ${doc.uri.fsPath}`);
    if (documents.length === 0) return;

    await updateFileEmbeddings(documents);
    vscode.window.showInformationMessage(`Needle re-indexed ${documents.length} chunks from ${path.basename(doc.uri.fsPath)}`);
    logger.info(`[Needle] Successfully updated embeddings for ${doc.uri.fsPath}`);
  }, null, context.subscriptions);
}
