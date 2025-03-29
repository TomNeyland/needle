// src/utils/embeddingUtils.ts
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { parseDocument } from 'htmlparser2';

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

/**
 * Splits a large class definition into smaller chunks based on its methods.
 * @param symbol The class symbol to split.
 * @param doc The document containing the class.
 * @returns An array of smaller symbols representing parts of the class.
 */
export function splitLargeClass(symbol: vscode.DocumentSymbol, doc: vscode.TextDocument): vscode.DocumentSymbol[] {
  if (symbol.kind !== vscode.SymbolKind.Class) {
    return [symbol]; // Not a class, return as-is
  }

  const size = symbol.range.end.line - symbol.range.start.line + 1;
  if (size <= 100) {
    return [symbol]; // Small enough, no need to split
  }

  console.log(`[Search++] Splitting large class: ${symbol.name} - ${size} lines`);

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
      console.debug(`[Search++] Skipping large class: ${name} - ${size} lines`);
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

  // Filter out individual methods from classes unless they're large enough to be significant
  // if (
  //   kind === vscode.SymbolKind.Method && 
  //   size < 15 // Increased threshold to filter out more methods
  // ) {
  //   console.log(`[Search++] Skipping class method: ${name} - ${size} lines`);
  //   return true;
  // }

  // 🔥 Skip tiny variable *symbols* (not code) — e.g., just `path`
  if (
    kind === vscode.SymbolKind.Variable &&
    size === 1 &&
    symbol.children.length === 0
  ) {
    const text = doc.getText(symbol.selectionRange).trim();
    // if the selected text is a single identifier (no `=` or `:` or keyword), skip it
    if (/^[a-zA-Z_$][\w$]*$/.test(text)) {
      // console.debug(`[Search++] Skipping trivial variable symbol: "${text}"`);
      return true;
    }
  }

  // Skip any non-important tiny symbols
  if (size < 3) {
    // console.log(`[Search++] Skipping small symbol: ${name} (${vscode.SymbolKind[kind]}) - ${size} lines`);
    return true;
  }

  return false;
}

/**
 * Parses an HTML document and extracts symbols (tags and attributes).
 * @param doc The HTML document to parse.
 * @returns An array of FlattenedSymbol objects representing HTML elements.
 */
export function parseHTMLSymbols(doc: vscode.TextDocument): { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] }[] {
  const content = doc.getText();
  const dom = parseDocument(content);
  const result: { symbol: vscode.DocumentSymbol; parents: vscode.DocumentSymbol[] }[] = [];
  
  // Map to store parent-child relationships
  const symbolMap = new Map<any, vscode.DocumentSymbol>();
  
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
      
      try {
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
        
        // Store the relationship between DOM node and symbol
        symbolMap.set(node, symbol);
        
        // Add this symbol to the result with its parent hierarchy
        result.push({ symbol, parents });
        
        // Process children
        if (node.children && node.children.length > 0) {
          const newParents = [...parents, symbol];
          for (const child of node.children) {
            traverseNode(child, newParents);
          }
        }
      } catch (err) {
        console.warn(`[Search++] Error processing HTML node: ${err}`);
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
  
  console.log(`[Search++] Found ${result.length} HTML symbols`);
  return result;
}

/**
 * Extracts a portion of code from the document centered around the symbol range,
 * limiting to a maximum size.
 * @param doc The text document containing the code
 * @param symbolRange The range of the symbol in the document
 * @param maxSize Maximum character length of the extracted code
 * @returns A string containing the extracted code
 */
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
