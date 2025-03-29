// src/utils/embeddingUtils.ts
import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface EmbeddedChunk {
  embedding: number[];
  code: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  fingerprint: string;
  context?: string;
}

export interface OpenAIEmbeddingResponse {
  data: {
    embedding: number[];
  }[];
}

export interface EmbeddingResponse {
  embedding: number[];
}

/**
 * Generates a unique fingerprint for a code snippet using SHA-256
 */
export function generateFingerprint(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Calculates the cosine similarity between two embedding vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

/**
 * Extracts context for a symbol including its parent hierarchy and docstrings
 */
export function getSymbolContextWithParents(
  symbol: vscode.DocumentSymbol,
  parents: vscode.DocumentSymbol[],
  doc: vscode.TextDocument
): string {
  // Filter out redundant parent names that are already contained in child names
  const filteredParents = parents.filter(parent => 
    !symbol.name.includes(parent.name) && 
    !parents.some(p => p !== parent && p.name.includes(parent.name))
  );
  
  const names = filteredParents.map(s => s.name);
  names.push(symbol.name);

  // For method/function symbols, include the first line (signature) as context
  const firstLine = doc.lineAt(symbol.range.start.line).text.trim();
  
  // Include docstring or preceding comments (up to 3 lines above)
  const docRangeStart = Math.max(symbol.range.start.line - 3, 0);
  const contextLines = doc.getText(
    new vscode.Range(docRangeStart, 0, symbol.range.start.line, 0)
  )
  .split('\n')
  .filter(line => line.trim().startsWith('*') || line.trim().startsWith('//') || line.trim().startsWith('#'))
  .join('\n')
  .trim();

  const context = names.join(' > ');
  
  // Only add docstring if it's not empty and not too long
  if (contextLines && contextLines.length < 200) {
    return context + (contextLines ? '\n' + contextLines : '');
  }
  
  return context;
}