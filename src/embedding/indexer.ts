// src/embedding/indexer.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLocalEmbedding } from './embeddings';
import { EmbeddedChunk, generateFingerprint, getSymbolContextWithParents } from '../utils';
import { startEmbeddingServer } from './server';
import { global } from '../extension';
const EMBEDDING_FILE = 'searchpp.embeddings.json';
const PARALLEL_EMBED_LIMIT = 75; // Configurable rate limit

/**
 * Indexes the entire workspace and creates embeddings for all supported code files
 */
export async function indexWorkspace(apiKey: string): Promise<EmbeddedChunk[]> {
  console.log('[Search++] Indexing full workspace...');
  
  // Make sure server is running
  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    vscode.window.showErrorMessage('Search++: Failed to start embedding server. Indexing will not work.');
    return [];
  }
  
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    return [];
  }
  
  const files = await vscode.workspace.findFiles('**/*.{ts,js,tsx,jsx,py,java,go,rs}', '**/node_modules/**');
  let embeddedChunks: EmbeddedChunk[] = [];
  
  // Set to track fingerprints we've already processed to avoid duplicates
  const processedFingerprints = new Set<string>();
  
  for (const file of files) {
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', file
      );
      
      if (!symbols) {
        continue;
      }
      
      // First pass: collect all symbols that we want to embed
      type FlattenedSymbol = {
        symbol: vscode.DocumentSymbol;
        parents: vscode.DocumentSymbol[];
      };
      
      const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): FlattenedSymbol[] => {
        return symbols.flatMap(sym => [
          { symbol: sym, parents },
          ...flatten(sym.children, [...parents, sym])
        ]);
      };
      
      const flattened = flatten(symbols);
      
      // Second pass: Process only non-overlapping or minimally overlapping symbols
      // Sort by symbol size (smaller symbols first)
      flattened.sort((a, b) => {
        const aSize = a.symbol.range.end.line - a.symbol.range.start.line;
        const bSize = b.symbol.range.end.line - b.symbol.range.start.line;
        return aSize - bSize; 
      });
      
      // Process symbols
      const processedRanges: {start: number, end: number}[] = [];
      
      for (let i = 0; i < flattened.length; i += PARALLEL_EMBED_LIMIT) {
        const batch = flattened.slice(i, i + PARALLEL_EMBED_LIMIT);
        
        // Filter out heavily overlapping symbols
        const filteredBatch = batch.filter(({ symbol }) => {
          const symbolRange = {
            start: symbol.range.start.line,
            end: symbol.range.end.line
          };
          
          // Skip if this range heavily overlaps with a processed range
          // Allow small overlaps (less than 30% of the symbol)
          const overlappingRange = processedRanges.find(range => {
            const overlap = Math.min(range.end, symbolRange.end) - Math.max(range.start, symbolRange.start);
            const symbolSize = symbolRange.end - symbolRange.start;
            // Skip if overlap is more than 30% of the symbol size
            return overlap > 0 && overlap > symbolSize * 0.3;
          });
          
          if (overlappingRange) {
            return false;
          }
          
          // If not heavily overlapping, add to processed ranges
          processedRanges.push(symbolRange);
          return true;
        });
        
        await Promise.all(filteredBatch.map(async ({ symbol, parents }) => {
          const code = doc.getText(symbol.range);
          const fingerprint = generateFingerprint(code);
          
          // Skip if we've already processed this exact code
          if (processedFingerprints.has(fingerprint)) {
            return;
          }
          
          processedFingerprints.add(fingerprint);
          
          const context = getSymbolContextWithParents(symbol, parents, doc);
          // Use local embedding instead of OpenAI
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

/**
 * Setup file watcher to re-index files when they change
 */
export function setupFileWatcher(context: vscode.ExtensionContext): void {
  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    console.log(`[Search++] File saved: ${doc.uri.fsPath}`);
    
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    const workspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const embeddingPath = path.join(workspacePath, EMBEDDING_FILE);
    let embeddedChunks: EmbeddedChunk[] = [];

    if (fs.existsSync(embeddingPath)) {
      embeddedChunks = JSON.parse(fs.readFileSync(embeddingPath, 'utf-8'));
    }

    const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider', doc.uri
    );

    if (!documentSymbols) {
      return;
    }

    const updatedChunks: EmbeddedChunk[] = [];

    const flattenSymbols = (symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] => {
      return symbols.flatMap(symbol => [symbol, ...flattenSymbols(symbol.children)]);
    };

    const flattened = flattenSymbols(documentSymbols);

    console.log(`[Search++] Re-embedding ${flattened.length} symbols from ${doc.uri.fsPath}`);

    const embedInBatches = async (symbols: vscode.DocumentSymbol[]) => {
      type FlattenedSymbol = {
        symbol: vscode.DocumentSymbol;
        parents: vscode.DocumentSymbol[];
      };
    
      const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): FlattenedSymbol[] => {
        return symbols.flatMap(sym => [
          { symbol: sym, parents },
          ...flatten(sym.children, [...parents, sym])
        ]);
      };
    
      const flattened = flatten(symbols);
    
      for (let i = 0; i < flattened.length; i += PARALLEL_EMBED_LIMIT) {
        const batch = flattened.slice(i, i + PARALLEL_EMBED_LIMIT);
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
          console.log(`[Search++] Embedding symbol '${symbol.name}' from ${doc.uri.fsPath}`);
          // Use local embedding instead of API key
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
    };

    await embedInBatches(flattened);

    embeddedChunks = embeddedChunks.filter(chunk => chunk.filePath !== doc.uri.fsPath);
    embeddedChunks.push(...updatedChunks);
    fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Search++ re-indexed ${updatedChunks.length} chunks from ${path.basename(doc.uri.fsPath)}`);
    console.log(`[Search++] Saved updated embeddings for ${doc.uri.fsPath}`);
  }, null, context.subscriptions);
}