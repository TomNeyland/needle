// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SearchSidebarViewProvider } from './SearchSidebarViewProvider';

interface EmbeddedChunk {
  embedding: number[];
  code: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  fingerprint: string;
  context?: string;
}

interface OpenAIEmbeddingResponse {
  data: {
    embedding: number[];
  }[];
}

const EMBEDDING_FILE = 'searchpp.embeddings.json';
const PARALLEL_EMBED_LIMIT = 25; // Configurable rate limit


function generateFingerprint(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function getSymbolContextWithParents(
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

// Declare this variable at a higher scope so we can access the provider
let searchSidebarProvider: SearchSidebarViewProvider;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  // Create and register the sidebar provider
  searchSidebarProvider = new SearchSidebarViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'searchpp.sidebar',
      searchSidebarProvider
    )
  );

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(search) Search++";
  statusBarItem.tooltip = "Click to open Search++";
  statusBarItem.command = "searchpp.smartFind";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register the command to set the API key
  const setApiKeyCommand = vscode.commands.registerCommand('searchpp.setApiKey', async () => {
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Enter your OpenAI API Key',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...'
    });
    
    if (apiKey) {
      await context.globalState.update('searchpp.openaiApiKey', apiKey);
      vscode.window.showInformationMessage('Search++: API Key saved successfully');
    }
  });

  context.subscriptions.push(setApiKeyCommand);

  // Register the smart find command
  const disposable = vscode.commands.registerCommand('searchpp.smartFind', async (query?: string) => {
    if (!query) {
      query = await vscode.window.showInputBox({
        prompt: 'Search++: What are you looking for?',
        placeHolder: 'e.g., Where do we validate user input?'
      });
    }

    if (!query) {
      vscode.window.showWarningMessage('Search++: No query entered.');
      return;
    }

    // Focus the sidebar view if it exists
    vscode.commands.executeCommand('searchpp.sidebar.focus');
    
    // Perform the search
    const results = await vscode.commands.executeCommand('searchpp.performSearch', query);
    
    // The results will be displayed in the sidebar by the performSearch command
  });

  context.subscriptions.push(disposable);

  // Add a new command for performing a search that returns results to the sidebar
  const performSearchCommand = vscode.commands.registerCommand('searchpp.performSearch', async (query?: string) => {
    if (!query) {
      return [];
    }
  
    const apiKey = await getOpenAIKey(context);
    if (!apiKey) {
      vscode.window.showErrorMessage('Search++: OpenAI API Key is required.');
      return [];
    }
  
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('Search++: No workspace folder open.');
      return [];
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const embeddingPath = path.join(workspacePath, EMBEDDING_FILE);
  
    let embeddedChunks: EmbeddedChunk[] = [];
    if (fs.existsSync(embeddingPath)) {
      console.log(`[Search++] Loading embeddings from ${embeddingPath}`);
      const raw = fs.readFileSync(embeddingPath, 'utf-8');
      embeddedChunks = JSON.parse(raw);
    } else {
      console.log('[Search++] Embedding file not found. Starting full indexing...');
      embeddedChunks = await indexWorkspace(apiKey);
      fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
      console.log(`[Search++] Indexed and stored ${embeddedChunks.length} code chunks.`);
    }
  
    console.log('[Search++] Embedding user query...');
    const queryEmbedding = await getEmbedding(query, apiKey);
    if (!queryEmbedding) {
      vscode.window.showErrorMessage('Search++: Failed to embed query.');
      return [];
    }
  
    console.log('[Search++] Scoring matches...');
    const results = embeddedChunks.map(chunk => {
      return {
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
      };
    }).sort((a, b) => b.score - a.score);
    
    // Deduplicate results based on code content and file path
    const deduplicatedResults = [];
    const seenFingerprints = new Set<string>();
    
    for (const result of results) {
      // Create a composite key of file path + fingerprint
      const compositeKey = `${result.filePath}:${result.fingerprint}`;
      
      if (!seenFingerprints.has(compositeKey)) {
        seenFingerprints.add(compositeKey);
        deduplicatedResults.push(result);
        
        // Only take the first 15 deduplicated results
        if (deduplicatedResults.length >= 15) {
          break;
        }
      }
    }
  
    console.log(`[Search++] Top matches: ${deduplicatedResults.length}`);
    return deduplicatedResults;
  });

  context.subscriptions.push(performSearchCommand);

  vscode.workspace.onDidSaveTextDocument(async (doc) => {
    console.log(`[Search++] File saved: ${doc.uri.fsPath}`);
    const apiKey = await getOpenAIKey(context);
    if (!apiKey || !vscode.workspace.workspaceFolders) return;

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
          const embedding = await getEmbedding(code, apiKey);
    
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
  });
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

async function getOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  // First check the context's global state
  const apiKey = context.globalState.get<string>('searchpp.openaiApiKey');
  
  // Then check environment variable as fallback
  const envApiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey && !envApiKey) {
    const response = await vscode.window.showInformationMessage(
      'Search++: OpenAI API Key is required for semantic search.',
      'Set API Key',
      'Cancel'
    );
    
    if (response === 'Set API Key') {
      return vscode.commands.executeCommand('searchpp.setApiKey');
    }
    
    return undefined;
  }
  
  return apiKey || envApiKey;
}

async function getEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  try {
    console.log(`[Search++] Sending embedding request for text (length: ${text.length})`);
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text
      })
    });

    const data: OpenAIEmbeddingResponse = await res.json() as OpenAIEmbeddingResponse;
    console.log('[Search++] Received embedding response');
    return data?.data?.[0]?.embedding || null;
  } catch (err) {
    console.error('Embedding error:', err);
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}


// Replace the indexWorkspace function with this improved version:
async function indexWorkspace(apiKey: string): Promise<EmbeddedChunk[]> {
  console.log('[Search++] Indexing full workspace...');
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return [];

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

      if (!symbols) continue;

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
          const embedding = await getEmbedding(code, apiKey);
          
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