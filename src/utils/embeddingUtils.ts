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
  const kind = symbol.kind;
  const name = symbol.name;
  const size = symbol.range.end.line - symbol.range.start.line + 1;

  // Always include high-value symbols
  if (
    kind === vscode.SymbolKind.Class ||
    kind === vscode.SymbolKind.Constructor ||
    name.toLowerCase().includes('__init__') ||
    name.toLowerCase().includes('constructor')
  ) {
    return false;
  }

  // 🔥 Skip tiny variable *symbols* (not code) — e.g., just `path`
  if (
    kind === vscode.SymbolKind.Variable &&
    size === 1 &&
    symbol.children.length === 0
  ) {
    const text = doc.getText(symbol.selectionRange).trim();
    // if the selected text is a single identifier (no `=` or `:` or keyword), skip it
    if (/^[a-zA-Z_$][\w$]*$/.test(text)) {
      console.log(`[Search++] Skipping trivial variable symbol: "${text}"`);
      return true;
    }
  }

  // Optional: skip any non-important tiny symbols
  if (size < 3) {
    console.log(`[Search++] Skipping small symbol: ${name} (${vscode.SymbolKind[kind]}) - ${size} lines`);
    return true;
  }

  return false;
}

