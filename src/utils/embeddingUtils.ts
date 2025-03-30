// src/utils/embeddingUtils.ts
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { parseDocument } from 'htmlparser2';
// import { Ignore } from 'ignore';
import * as fs from 'fs';

// const gitignore = Ignore();

// // Load .gitignore rules if the file exists
// const gitignorePath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', '.gitignore');
// if (fs.existsSync(gitignorePath)) {
//   const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
//   gitignore.add(gitignoreContent);
// }

export function isFileInAHiddenFolder(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  return segments.some(segment => segment.startsWith('.') && segment.length > 1);
}

export function isExcludedFileType(filePath: string): boolean {
  const excludedExtensions = ['.json', '.sqlite', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.exe'];
  return excludedExtensions.some(ext => filePath.endsWith(ext));
}

export function isIgnoredByGitignore(filePath: string): boolean {
  return false;
  // const relativePath = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', filePath);
  // return gitignore.ignores(relativePath);
}

export function shouldExcludeFile(filePath: string): boolean {
  return isFileInAHiddenFolder(filePath) || isExcludedFileType(filePath) || isIgnoredByGitignore(filePath);
}

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

  const docRangeStart = Math.max(symbol.range.start.line - 3, 0);
  const contextLines = doc.getText(
    new vscode.Range(docRangeStart, 0, symbol.range.start.line, 0)
  )
  .split('\n')
  .filter(line => line.trim().startsWith('*') || line.trim().startsWith('//') || line.trim().startsWith('#'))
  .join('\n')
  .trim();

  const fileExtension = path.extname(doc.uri.fsPath);
  if (fileExtension === '.html') {
    const tagName = symbol.name; // Assume symbol name is the tag name
    const attributes = doc.getText(symbol.range).match(/<\s*[\w-]+\s+([^>]+)>/)?.[1] || '';
    const context = `<${tagName} ${attributes.trim()}>`.trim();
    return context;
  }

  const symbolDetail = symbol.detail ? ` (${symbol.detail})` : '';
  const parentHierarchy = filteredParents.map(p => `[${p.kind}] ${p.name}`).join(' > ');

  const context = `[${symbol.kind}] ${names.join(' > ')} (${fileExtension})${symbolDetail}`;

  if (contextLines && contextLines.length < 200) {
    return context + (contextLines ? '\n' + contextLines : '') + (parentHierarchy ? `\nParents: ${parentHierarchy}` : '');
  }

  return context + (parentHierarchy ? `\nParents: ${parentHierarchy}` : '');
}

/**
 * Determines if a code chunk is minified based on its density.
 * @param code The code chunk to evaluate.
 * @returns True if the code is minified, false otherwise.
 */
export function isMinifiedCode(code: string): boolean {
  const lines = code.split('\n').length;
  const nonWhitespaceChars = code.replace(/\s/g, '').length;
  const density = nonWhitespaceChars / lines;
  return density > 300; // Adjust threshold as needed
}

export function splitLargeClass(symbol: vscode.DocumentSymbol, doc: vscode.TextDocument): vscode.DocumentSymbol[] {
  if (symbol.kind !== vscode.SymbolKind.Class) {
    return [symbol]; // Not a class, return as-is
  }

  const size = symbol.range.end.line - symbol.range.start.line + 1;
  if (size <= 100) {
    return [symbol]; // Small enough, no need to split
  }

  // Extract methods and other significant children
  const significantChildren = symbol.children.filter(child =>
    child.kind === vscode.SymbolKind.Method || child.kind === vscode.SymbolKind.Constructor
  );

  if (significantChildren.length === 0) {
    return [symbol]; // No significant children, return as-is
  }

  return significantChildren.map(child => {
    const newSymbol = new vscode.DocumentSymbol(
      `${symbol.name}.${child.name}`, // Include parent class name
      child.detail,
      child.kind,
      child.range,
      child.selectionRange
    );
    newSymbol.children = child.children; // Preserve any nested children
    return newSymbol;
  });
}

export function symbolIsTooSmall(symbol: vscode.DocumentSymbol, doc: vscode.TextDocument): boolean {
  const kind = symbol.kind;
  const name = symbol.name;
  const size = symbol.range.end.line - symbol.range.start.line + 1;

  // For classes, split large ones into smaller chunks
  if (kind === vscode.SymbolKind.Class) {
    if (size > 100) {
      return true; // Skip the entire class if not split
    }
    return false; // Include smaller classes
  }
  
  // Always include constructors
  if (
    kind === vscode.SymbolKind.Constructor ||
    name.toLowerCase().includes('__init__') ||
    name.toLowerCase().includes('constructor')
  ) {
    return false;
  }

  // Skip tiny variable *symbols* (not code) — e.g., just `path`
  if (
    kind === vscode.SymbolKind.Variable &&
    size === 1 &&
    symbol.children.length === 0
  ) {
    const text = doc.getText(symbol.selectionRange).trim();
    // if the selected text is a single identifier (no `=` or `:` or keyword), skip it
    if (/^[a-zA-Z_$][\w$]*$/.test(text)) {
      return true;
    }
  }

  // Skip any non-important tiny symbols
  if (size < 3) {
    return true;
  }

  return false;
}

export function parseHTMLSymbols(doc: vscode.TextDocument): { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] }[] {
  const content = doc.getText();
  const dom = parseDocument(content);
  const result: { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] }[] = [];
  
  // Helper function to recursively traverse DOM nodes
  function traverseNode(node: any, parents: vscode.DocumentSymbol[] = []): void {
    // Only process elements (tags)
    if (node.type === 'tag' || node.type === 'script' || node.type === 'style') {
      // Get start and end positions for the node
      const startOffset = node.startIndex || 0;
      const endOffset = node.endIndex || content.length;
      
      // Skip if we can't determine the position
      if (startOffset === undefined || endOffset === undefined) {
        return;
      }
      
      // Convert offsets to VSCode positions
      const startPos = doc.positionAt(startOffset);
      const endPos = doc.positionAt(endOffset);
      
      // Create a range for this element
      const range = new vscode.Range(startPos, endPos);
      
      // Create a name with tag and important attributes (like id, class)
      let name = node.name || 'unknown';
      let detail = '';
      
      // Add attributes to the detail
      if (node.attribs) {
        const attrs = Object.entries(node.attribs);
        if (attrs.length > 0) {
          detail = attrs.map(([key, value]) => `${key}="${value}"`).join(' ');
          
          // Add id to name if available
          if (node.attribs.id) {
            name += `#${node.attribs.id}`;
          }
          // Add class to name if available
          if (node.attribs.class) {
            name += `.${node.attribs.class.replace(/\s+/g, '.')}`;
          }
        }
      }
      
      // Create symbol for this element
      const symbol = new vscode.DocumentSymbol(
        name,
        detail,
        vscode.SymbolKind.Field,
        range,
        range
      );
      
      // Add this symbol to the result with its parent hierarchy
      result.push({ symbol, parents });
      
      // Process children
      if (node.children && node.children.length > 0) {
        const newParents = [...parents, symbol];
        for (const child of node.children) {
          traverseNode(child, newParents);
        }
      }
    } else if (node.children && node.children.length > 0) {
      // For non-element nodes with children (like document), just process children
      for (const child of node.children) {
        traverseNode(child, parents);
      }
    }
  }
  
  // Start traversal from root
  if (dom.children && dom.children.length > 0) {
    for (const child of dom.children) {
      traverseNode(child);
    }
  }
  
  return result;
}

export function extractCenteredCode(doc: vscode.TextDocument, symbolRange: vscode.Range, maxSize: number): string {
  const code = doc.getText(symbolRange);
  
  if (code.length <= maxSize) {
    return code; // Return the entire code if it's within the size limit
  }
  
  // Calculate the center offset in the original code
  const centerOffset = Math.floor(code.length / 2);
  
  // Calculate start and end positions to extract centered code
  const halfMaxSize = Math.floor(maxSize / 2);
  let start = centerOffset - halfMaxSize;
  let end = centerOffset + halfMaxSize;
  
  // Adjust if we're at the edges
  if (start < 0) {
    end += Math.abs(start); // Shift the end right if start is negative
    start = 0;
  }
  
  if (end > code.length) {
    start = Math.max(0, start - (end - code.length)); // Shift start left if end is beyond bounds
    end = code.length;
  }
  
  // Extract the centered portion
  return code.substring(start, end);
}

export async function collectDocumentsFromWorkspace(): Promise<{ document: string; metadata: any }[]> {
  const documents: { document: string; metadata: any }[] = [];
  const files = await vscode.workspace.findFiles(
    '**/*', // Include all files
    '**/{node_modules,.*}/**' // Exclude node_modules and hidden directories
  );

  for (const file of files) {
    try {
      const filePath = file.fsPath;
      if (shouldExcludeFile(filePath)) {
        console.log(`[Search++] Excluding file: ${filePath}`);
        continue;
      }

      const doc = await vscode.workspace.openTextDocument(file);
      const fileExtension = path.extname(file.fsPath);

      let symbols: { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] }[] = [];
      if (fileExtension === '.html') {
        symbols = parseHTMLSymbols(doc);
      } else {
        const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', file
        );
        if (!documentSymbols) continue;

        const flatten = (symbols: vscode.DocumentSymbol[], parents: vscode.DocumentSymbol[] = []): { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] }[] =>
          symbols.flatMap(sym => [{ symbol: sym, parents }, ...flatten(sym.children, [...parents, sym])]);

        symbols = flatten(documentSymbols).sort((a, b) =>
          a.symbol.range.start.line - b.symbol.range.start.line
        );
      }

      const nonOverlapping: { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] }[] = [];
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
        const code = extractCenteredCode(doc, symbol.range, 1000);
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

  return documents;
}
