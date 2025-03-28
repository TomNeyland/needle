// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SearchSidebarViewProvider } from './SearchSidebarViewProvider';

interface EmbeddedChunk {
  embedding: number[];
  code: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

interface OpenAIEmbeddingResponse {
  data: {
    embedding: number[];
  }[];
}

const EMBEDDING_FILE = 'searchpp.embeddings.json';
const PARALLEL_EMBED_LIMIT = 25; // Configurable rate limit

export function activate(context: vscode.ExtensionContext) {
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

    const apiKey = await getOpenAIKey(context);
    if (!apiKey) {
      vscode.window.showErrorMessage('Search++: OpenAI API Key is required.');
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage('Search++: No workspace folder open.');
      return;
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
      return;
    }

    console.log('[Search++] Scoring matches...');
    const results = embeddedChunks.map(chunk => {
      return {
        ...chunk,
        score: cosineSimilarity(queryEmbedding, chunk.embedding)
      };
    }).sort((a, b) => b.score - a.score).slice(0, 5);

    console.log('[Search++] Top 5 matches:', results);

    const resultItems = results.map(r => ({
      label: `${path.basename(r.filePath)}:${r.lineStart + 1} (${r.score.toFixed(2)})`,
      description: r.code.split('\n').slice(0, 3).join(' ').trim(),
      detail: r.filePath,
      chunk: r
    }));

    const picked = await vscode.window.showQuickPick(resultItems, {
      title: 'Search++ Top Matches',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (picked && picked.chunk) {
      const uri = vscode.Uri.file(picked.chunk.filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const range = new vscode.Range(picked.chunk.lineStart, 0, picked.chunk.lineEnd + 1, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.end);
    }
  });

  context.subscriptions.push(disposable);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'searchpp.sidebar',
      new SearchSidebarViewProvider(context)
    )
  );

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
      for (let i = 0; i < symbols.length; i += PARALLEL_EMBED_LIMIT) {
        const batch = symbols.slice(i, i + PARALLEL_EMBED_LIMIT);
        await Promise.all(batch.map(async symbol => {
          const code = doc.getText(symbol.range);
          console.log(`[Search++] Embedding symbol '${symbol.name}' of kind ${vscode.SymbolKind[symbol.kind]} from ${doc.uri.fsPath} lines ${symbol.range.start.line}-${symbol.range.end.line}`);
          const embedding = await getEmbedding(code, apiKey);
          if (embedding) {
            updatedChunks.push({
              embedding,
              code,
              filePath: doc.uri.fsPath,
              lineStart: symbol.range.start.line,
              lineEnd: symbol.range.end.line
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

export function deactivate() {}

async function getOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return process.env.OPENAI_API_KEY || context.globalState.get<string>('searchpp.openaiApiKey');
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

async function indexWorkspace(apiKey: string): Promise<EmbeddedChunk[]> {
  console.log('[Search++] Indexing full workspace...');
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider', ''
  );

  if (!symbols || symbols.length === 0) {
    vscode.window.showWarningMessage('Search++: No symbols found in workspace.');
    return [];
  }

  const codeChunks: { code: string; filePath: string; lineStart: number; lineEnd: number }[] = [];

  for (const symbol of symbols) {
    try {
      const doc = await vscode.workspace.openTextDocument(symbol.location.uri);
      const code = doc.getText(symbol.location.range);
      codeChunks.push({
        code,
        filePath: symbol.location.uri.fsPath,
        lineStart: symbol.location.range.start.line,
        lineEnd: symbol.location.range.end.line,
      });
    } catch (err) {
      console.warn(`[Search++] Failed to load symbol from ${symbol.location.uri.fsPath}`, err);
    }
  }

  const embeddedChunks: EmbeddedChunk[] = [];
  for (let i = 0; i < codeChunks.length; i += PARALLEL_EMBED_LIMIT) {
    const batch = codeChunks.slice(i, i + PARALLEL_EMBED_LIMIT);
    await Promise.all(batch.map(async chunk => {
      console.log(`[Search++] Embedding chunk from ${chunk.filePath} lines ${chunk.lineStart}-${chunk.lineEnd}`);
      const embedding = await getEmbedding(chunk.code, apiKey);
      if (embedding) {
        embeddedChunks.push({ ...chunk, embedding });
      }
    }));
  }

  return embeddedChunks;
}
