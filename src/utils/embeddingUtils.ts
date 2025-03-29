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

export function generateFingerprint(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

export function getSymbolContextWithParents(
  symbol: vscode.DocumentSymbol,
  parents: vscode.DocumentSymbol[],
  doc: vscode.TextDocument
): string {
  const filteredParents = parents.filter(parent => 
    !symbol.name.includes(parent.name) && 
    !parents.some(p => p !== parent && p.name.includes(parent.name))
  );

  const names = filteredParents.map(s => s.name);
  names.push(symbol.name);
  const firstLine = doc.lineAt(symbol.range.start.line).text.trim();

  const docRangeStart = Math.max(symbol.range.start.line - 3, 0);
  const contextLines = doc.getText(
    new vscode.Range(docRangeStart, 0, symbol.range.start.line, 0)
  )
  .split('\n')
  .filter(line => line.trim().startsWith('*') || line.trim().startsWith('//') || line.trim().startsWith('#'))
  .join('\n')
  .trim();

  const context = `[${symbol.kind}] ${names.join(' > ')}`;

  if (contextLines && contextLines.length < 200) {
    return context + (contextLines ? '\n' + contextLines : '');
  }

  return context;
}

export function symbolIsTooSmall(symbol: vscode.DocumentSymbol, doc: vscode.TextDocument): boolean {
  const code = doc.getText(symbol.range).trim();
  const length = code.length;
  if (length < 10 || length > 4000) return true;
  if (!/[=({]/.test(code)) return true;
  return false;
}

export function isTooLargeForEmbedding(code: string): boolean {
  const approxTokens = Math.ceil(code.length / 4);
  return approxTokens > 8000;
}
