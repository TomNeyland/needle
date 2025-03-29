// src/search/performSearch.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddedChunk, parseHTMLSymbols, symbolIsTooSmall, generateFingerprint, getSymbolContextWithParents, extractCenteredCode } from '../utils/embeddingUtils';
import { updateFileEmbeddings, FlattenedSymbol } from '../embedding/indexer';
import { startEmbeddingServer } from '../embedding/server';
import { global } from '../extension';

const SIMILARITY_THRESHOLD = 0.2; // Only consider results with a score above this threshold
const MAX_RESULTS = 15; // Maximum number of results to return
const MAX_CODE_CHUNK_SIZE = 1000; // Maximum characters allowed in a code chunk

/**
 * Determines if a code chunk is minified based on its density.
 * @param code The code chunk to evaluate.
 * @returns True if the code is minified, false otherwise.
 */
function isMinifiedCode(code: string): boolean {
  const lines = code.split('\n').length;
  const nonWhitespaceChars = code.replace(/\s/g, '').length;
  const density = nonWhitespaceChars / lines;
  return density > 300; // Adjust threshold as needed
}

/**
 * Checks if a file path should be excluded based on a regex pattern
 * @param filePath The file path to check
 * @param exclusionPattern The regex pattern to match against
 * @returns True if the file should be excluded, false otherwise
 */
function shouldExcludeFile(filePath: string, exclusionPattern: string): boolean {
  if (!exclusionPattern) return false;
  
  try {
    // Split by comma to support multiple patterns like "scss, py"
    const patterns = exclusionPattern.split(',').map(p => p.trim()).filter(p => p);
    
    for (const pattern of patterns) {
      // Convert glob patterns like *.{json,md} to proper regex
      let regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(',').join('|')})`)
        .trim();
      
      // If pattern is not a complete regex, wrap it to match anywhere in path
      if (!regexPattern.startsWith('^')) {
        regexPattern = `.*${regexPattern}`;
      }
      
      const regex = new RegExp(regexPattern, 'i');
      const isExcluded = regex.test(filePath);
      
      if (isExcluded) {
        console.log(`[Search++] Excluding file: ${filePath} (matched pattern: ${pattern})`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error(`[Search++] Invalid exclusion pattern: ${exclusionPattern}`, error);
    return false;
  }
}

/**
 * Performs semantic search based on a query and returns matching code chunks
 */
export async function performSearch(query: string, exclusionPattern: string = ''): Promise<EmbeddedChunk[]> {
  if (!query) {
    return [];
  }

  console.log(`[Search++] Performing search for query: "${query}"`);

  try {
    const res = await fetch('http://localhost:8000/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        max_results: MAX_RESULTS,
        similarity_threshold: SIMILARITY_THRESHOLD
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Search++] Search API error ${res.status}: ${errorText}`);
      throw new Error(`[Search++] Failed to perform search: ${res.statusText}`);
    }

    const data = (await res.json()) as { results: EmbeddedChunk[] };
    let results: EmbeddedChunk[] = data.results;

    // Apply exclusion pattern filtering
    if (exclusionPattern) {
      results = results.filter(chunk => !shouldExcludeFile(chunk.filePath, exclusionPattern));
    }

    console.log(`[Search++] Found ${results.length} matching chunks.`);
    return results.slice(0, MAX_RESULTS); // Limit to max results
  } catch (err) {
    console.error(`[Search++] Error during search: ${err}`);
    return [];
  }
}

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