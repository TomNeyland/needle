// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as childProcess from 'child_process';
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

interface EmbeddingResponse {
  embedding: number[];
}

// Python server process configuration
let pythonProcess: childProcess.ChildProcess | undefined;
let serverReady = false;
const SERVER_PORT = 8000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const HEALTH_CHECK_INTERVAL = 2000; // 2 seconds

const EMBEDDING_FILE = 'searchpp.embeddings.json';
const PARALLEL_EMBED_LIMIT = 75; // Configurable rate limit

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

// Add the missing cosineSimilarity function
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

// Declare this variable at a higher scope so we can access the provider
let searchSidebarProvider: SearchSidebarViewProvider;
let statusBarItem: vscode.StatusBarItem;

// Keep a reference to the extension context globally to use in the embedding server
let global = { extensionContext: undefined as unknown as vscode.ExtensionContext };

export function activate(context: vscode.ExtensionContext) {
  // Store context globally for use in embedding server
  global.extensionContext = context;
  
  // Start the embedding server when the extension activates
  startEmbeddingServer(context).then(started => {
    if (started) {
      console.log('[Search++] Successfully started local embedding server');
    } else {
      console.error('[Search++] Failed to start local embedding server');
      vscode.window.showErrorMessage('Search++: Failed to start local embedding server. Semantic search will not work.');
    }
  });
  
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

    // Ensure the server is ready
    if (!serverReady) {
      const started = await startEmbeddingServer(context);
      if (!started) {
        vscode.window.showErrorMessage('Search++: Failed to start embedding server. Please try again.');
        return [];
      }
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
      // Pass empty string instead of API key since we don't need it anymore
      embeddedChunks = await indexWorkspace("");
      fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
      console.log(`[Search++] Indexed and stored ${embeddedChunks.length} code chunks.`);
    }

    console.log('[Search++] Embedding user query...');
    const queryEmbedding = await getLocalEmbedding(query);
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
    
    // No need to check for API key anymore - we're using local embeddings
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
  });
}


export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  
  // Stop the embedding server when extension deactivates
  stopEmbeddingServer().catch(err => {
    console.error('[Search++] Error stoppsing embedding server:', err);
  });
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

// New functions for managing the Python embedding server
// Fix curly brace issues in the startEmbeddingServer function
async function startEmbeddingServer(context: vscode.ExtensionContext): Promise<boolean> {
  if (pythonProcess) {
    console.log('[Search++] Embedding server already running');
    return serverReady;
  }

  return new Promise<boolean>(async (resolve) => {
    console.log('[Search++] Starting embedding server...');
    
    const extensionPath = context.extensionPath;
    const scriptPath = path.join(extensionPath, 'src', 'embedding', 'main.py');
    const venvPath = path.join(extensionPath, 'venv');
    const requirementsPath = path.join(extensionPath, 'src', 'embedding', 'requirements.txt');
    
    // Check if the script and requirements exist
    if (!fs.existsSync(scriptPath)) {
      vscode.window.showErrorMessage(`Search++: Embedding server script not found at ${scriptPath}`);
      return resolve(false);
    }

    if (!fs.existsSync(requirementsPath)) {
      vscode.window.showErrorMessage(`Search++: Requirements file not found at ${requirementsPath}`);
      return resolve(false);
    }

    // Create venv if it doesn't exist
    if (!fs.existsSync(venvPath)) {
      try {
        console.log('[Search++] Creating virtual environment...');
        await createVirtualEnvironment(extensionPath, venvPath);
      } catch (err) {
        console.error('[Search++] Failed to create virtual environment:', err);
        vscode.window.showErrorMessage('Search++: Failed to create Python virtual environment. Please ensure Python 3 is installed.');
        return resolve(false);
      }
    }

    // Determine the Python executable path
    const isWindows = process.platform === 'win32';
    const pythonExecutable = path.join(
      venvPath,
      isWindows ? 'Scripts' : 'bin',
      isWindows ? 'python.exe' : 'python'
    );

    // Install requirements if needed
    // try {
    //   await installRequirements(pythonExecutable, requirementsPath);
    // } catch (err) {
    //   console.error('[Search++] Failed to install requirements:', err);
    //   vscode.window.showErrorMessage('Search++: Failed to install Python dependencies.');
    //   return resolve(false);
    // }

    // Start the Python server with proper environment variables
    console.log(`[Search++] Using Python at: ${pythonExecutable}`);
    console.log(`[Search++] Running script: ${scriptPath}`);
    
    pythonProcess = childProcess.spawn(pythonExecutable, [scriptPath], {
      cwd: extensionPath,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: path.join(venvPath, isWindows ? 'Scripts' : 'bin') + path.delimiter + process.env.PATH,
        VIRTUAL_ENV: venvPath,
        SERVER_URL: SERVER_URL,
        UVICORN_WORKERS: "15"  // Add this environment variable
      }
    });

    // Add more detailed logging for debugging
    pythonProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`[Embedding Server] ${output}`);
      
      // Check if the output contains a message indicating the server is running
      if (output.includes('Server started') || output.includes('listening on')) {
        serverReady = true;
        resolve(true);
      }
    });
    
    // More detailed error logging
    pythonProcess.stderr?.on('data', (data) => {
      const errorMsg = data.toString().trim();
      console.error(`[Embedding Server Error] ${errorMsg}`);
      
      // Check if the error is related to missing dependencies
      if (errorMsg.includes('ModuleNotFoundError') || 
          errorMsg.includes('ImportError') || 
          errorMsg.includes('No module named')) {
        console.error('[Search++] Python module dependency error detected');
        vscode.window.showErrorMessage('Search++: Python dependency error. Try reinstalling the extension.');
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('[Search++] Failed to start embedding server:', err);
      pythonProcess = undefined;
      serverReady = false;
      resolve(false);
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[Search++] Embedding server exited with code ${code}`);
      pythonProcess = undefined;
      serverReady = false;
    });

    // Start health check to determine when server is ready
    let healthCheckAttempts = 0;
    const MAX_HEALTH_CHECK_ATTEMPTS = 30; // 30 attempts with 2-second intervals = 60 seconds max

    const healthCheckInterval = setInterval(async () => {
      try {
        console.log(`[Search++] Attempting health check #${healthCheckAttempts + 1} at ${SERVER_URL}/healthz`);
        const response = await fetch(`${SERVER_URL}/healthz`, { 
          // timeout: 2000,  // Add a timeout to the fetch
          headers: { 'Accept': 'application/json' }
        });
        
        if (response.ok) {
          clearInterval(healthCheckInterval);
          console.log('[Search++] Embedding server ready - health check passed');
          serverReady = true;
          resolve(true);
        } else {
          console.log(`[Search++] Health check returned status ${response.status}`);
        }
      } catch (err) {
        console.log(`[Search++] Health check failed: ${err.message}`);
        // Increment attempt counter
        healthCheckAttempts++;
        
        if (healthCheckAttempts >= MAX_HEALTH_CHECK_ATTEMPTS) {
          clearInterval(healthCheckInterval);
          console.error('[Search++] Embedding server health check failed after maximum attempts');
          
          // Check if process is still running before declaring failure
          if (pythonProcess && pythonProcess.pid) {
            try {
              // On Windows you might need a different approach to check process
              if (process.platform !== 'win32') {
                process.kill(pythonProcess.pid, 0); // Doesn't kill process, just checks if it exists
                console.log('[Search++] Process is still running, but health check is failing');
                
                // Maybe server is running but health endpoint is misconfigured
                vscode.window.showWarningMessage('Search++: Server process is running but health check is failing. Assuming server is ready.');
                serverReady = true;
                resolve(true);
                return;
              }
            } catch (e) {
              // Process is not running
              console.log('[Search++] Process is no longer running');
            }
          }
          
          resolve(false);
        }
      }
    }, HEALTH_CHECK_INTERVAL);

    // Set a timeout for server startup (this is a fallback in case the interval logic fails)
    setTimeout(() => {
      if (!serverReady) {
        clearInterval(healthCheckInterval);
        console.error('[Search++] Embedding server failed to start within timeout period');
        resolve(false);
      }
    }, 60000); // 60 seconds timeout
  });
}

// Helper function to create a virtual environment
async function createVirtualEnvironment(extensionPath: string, venvPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Try to find the Python executable
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    
    // First check if Python is available
    console.log(`[Search++] Checking Python installation...`);
    const checkProcess = childProcess.spawn(pythonCommand, ['--version']);
    
    let checkError = '';
    
    checkProcess.stderr?.on('data', (data) => {
      checkError += data.toString();
    });
    
    checkProcess.on('error', (err) => {
      console.error(`[Search++] Error checking Python: ${err.message}`);
      reject(new Error(`Python not found or not accessible. Make sure Python 3.6+ is installed and in your PATH.`));
    });
    
    checkProcess.on('exit', (checkCode) => {
      if (checkCode !== 0) {
        console.error(`[Search++] Python check failed: ${checkError}`);
        reject(new Error(`Python not available. Error: ${checkError}`));
        return;
      }
      
      // Check for ensurepip or venv module
      const moduleCheckProcess = childProcess.spawn(pythonCommand, [
        '-c', 
        'import sys; print("Python", sys.version); import ensurepip; print("ensurepip available")'
      ]);
      
      let moduleCheckError = '';
      let moduleCheckOutput = '';
      
      moduleCheckProcess.stdout?.on('data', (data) => {
        moduleCheckOutput += data.toString();
      });
      
      moduleCheckProcess.stderr?.on('data', (data) => {
        moduleCheckError += data.toString();
      });
      
      moduleCheckProcess.on('exit', (moduleCode) => {
        const hasEnsurepip = moduleCheckOutput.includes('ensurepip available');
        
        // Python is available, proceed to create virtual environment
        console.log(`[Search++] Creating virtual environment at ${venvPath}`);
        
        // If ensurepip is not available, use --without-pip option
        const venvArgs = hasEnsurepip ? 
          ['-m', 'venv', venvPath] : 
          ['-m', 'venv', '--without-pip', venvPath];
          
        console.log(`[Search++] Using venv command: ${pythonCommand} ${venvArgs.join(' ')}`);
        
        const venvProcess = childProcess.spawn(pythonCommand, venvArgs, {
          cwd: extensionPath,
          stdio: 'pipe'
        });
        
        let output = '';
        let errorOutput = '';
        
        venvProcess.stdout?.on('data', (data) => {
          output += data.toString();
          console.log(`[Search++ venv] ${data.toString().trim()}`);
        });
        
        venvProcess.stderr?.on('data', (data) => {
          errorOutput += data.toString();
          console.error(`[Search++ venv error] ${data.toString().trim()}`);
        });
        
        venvProcess.on('error', (err) => {
          console.error(`[Search++] Venv creation process error: ${err.message}`);
          reject(new Error(`Failed to create virtual environment: ${err.message}`));
        });
        
        venvProcess.on('exit', (code) => {
          if (code === 0) {
            console.log('[Search++] Virtual environment created successfully');
            
            // Save the information about whether pip was included
            if (!hasEnsurepip) {
              console.log('[Search++] Note: Virtual environment created without pip (ensurepip not available)');
            }
            
            resolve();
          } else {
            console.error(`[Search++] Venv creation failed with code ${code}`);
            console.error(`[Search++] Venv error output: ${errorOutput}`);
            
            // Try an alternative approach if the first one fails
            if (!output && !errorOutput) {
              reject(new Error(`Failed to create virtual environment. Exit code: ${code}. No error output available. Check if you have permissions to write to ${venvPath}.`));
            } else {
              reject(new Error(`Failed to create virtual environment. Exit code: ${code}. Error: ${errorOutput || output}`));
            }
          }
        });
      });
    });
  });
}

// Check if key requirements are already installed
async function checkRequirementsInstalled(pythonExecutable: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Try to import a key dependency (modify this based on your actual requirements)
    const checkProcess = childProcess.spawn(
      pythonExecutable, 
      ['-c', 'try: import numpy; import torch; print("Dependencies found"); except ImportError: print("Dependencies not found")'],
      { stdio: 'pipe' }
    );
    
    let output = '';
    
    checkProcess.stdout?.on('data', (data) => {
      output += data.toString().trim();
    });
    
    checkProcess.on('error', () => {
      resolve(false);
    });
    
    checkProcess.on('exit', () => {
      resolve(output.includes('Dependencies found'));
    });
  });
}

// Helper function to install requirements
async function installRequirements(pythonExecutable: string, requirementsPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    console.log(`[Search++] Installing requirements from ${requirementsPath}`);
    
    // Check if pip is available in the environment
    const checkPipProcess = childProcess.spawn(pythonExecutable, ['-m', 'pip', '--version'], {
      stdio: 'pipe'
    });
    
    let pipCheckError = '';
    
    checkPipProcess.stderr?.on('data', (data) => {
      pipCheckError += data.toString();
    });
    
    checkPipProcess.on('exit', async (pipCheckCode) => {
      // If pip is not available in venv, use system pip to install requirements directly
      if (pipCheckCode !== 0 || pipCheckError.includes('No module named pip')) {
        console.log('[Search++] Pip not found in environment, using system pip to install requirements directly...');
        
        try {
          const systemPipCmd = process.platform === 'win32' ? 'pip' : 'pip3';
          const venvPath = path.dirname(path.dirname(pythonExecutable)); // Get venv root from executable path
          // Determine the correct site-packages path
          let sitePackagesPath;
          if (process.platform === 'win32') {
            sitePackagesPath = path.join(venvPath, 'Lib', 'site-packages');
          } else {
            // Run a quick check to find the python version directory
            const pythonVersionCmd = childProcess.spawnSync(pythonExecutable, ['-c', 'import sys; print(f"python{sys.version_info.major}.{sys.version_info.minor}")']);
            const pythonVersionDir = pythonVersionCmd.stdout.toString().trim();
            sitePackagesPath = path.join(venvPath, 'lib', pythonVersionDir, 'site-packages');
          }
          
          console.log(`[Search++] Installing requirements to venv at ${sitePackagesPath} using system pip`);
          
          // Read the requirements file
          const requirements = fs.readFileSync(requirementsPath, 'utf8')
            .split('\n')
            .filter(line => line.trim() && !line.startsWith('#'));
          
          console.log(`[Search++] Installing packages: ${requirements.join(', ')}`);
          
          // Install each requirement separately to ensure best chance of success
          for (const req of requirements) {
            console.log(`[Search++] Installing ${req}...`);
            
            const pipArgs = ['install', '--target', sitePackagesPath, req.trim()];
            const installProcess = childProcess.spawn(systemPipCmd, pipArgs, {
              stdio: 'pipe'
            });
            
            let installOutput = '';
            let installError = '';
            
            installProcess.stdout?.on('data', (data) => {
              const text = data.toString().trim();
              installOutput += text;
              console.log(`[Search++ pip] ${text}`);
            });
            
            installProcess.stderr?.on('data', (data) => {
              const text = data.toString().trim();
              if (!text.includes('WARNING:') && !text.includes('DEPRECATION:')) {
                installError += text;
                console.error(`[Search++ pip error] ${text}`);
              }
            });
            
            await new Promise<void>((resolveInstall, rejectInstall) => {
              installProcess.on('exit', (code) => {
                if (code === 0) {
                  console.log(`[Search++] Successfully installed ${req}`);
                  resolveInstall();
                } else {
                  console.error(`[Search++] Failed to install ${req}`);
                  rejectInstall(new Error(`Failed to install ${req}: ${installError}`));
                }
              });
            });
          }
          
          console.log('[Search++] All requirements installed successfully using system pip');
          resolve();
          return;
          
        } catch (installError) {
          console.error('[Search++] Failed to install requirements with system pip:', installError);
          reject(new Error(`Failed to install requirements with system pip: ${installError.message || installError}`));
          return;
        }
      }
      
      // If we reach here, pip is available in the virtual environment
      const pipProcess = childProcess.spawn(pythonExecutable, ['-m', 'pip', 'install', '-r', requirementsPath], {
        stdio: 'pipe'
      });
      
      let output = '';
      let errorOutput = '';
      
      pipProcess.stdout?.on('data', (data) => {
        const text = data.toString().trim();
        output += text;
        console.log(`[Search++ pip] ${text}`);
      });
      
      pipProcess.stderr?.on('data', (data) => {
        const text = data.toString().trim();
        errorOutput += text;
        // Filter out pip warnings that aren't critical
        if (!text.includes('WARNING:') && !text.includes('DEPRECATION:')) {
          console.error(`[Search++ pip error] ${text}`);
        }
      });
      
      pipProcess.on('error', (err) => {
        reject(new Error(`Failed to install requirements: ${err.message}`));
      });
      
      pipProcess.on('exit', (code) => {
        if (code === 0) {
          console.log('[Search++] Requirements installed successfully');
          resolve();
        } else {
          console.error(`[Search++] Requirements installation failed with code ${code}`);
          
          // Try to provide more helpful error information
          if (errorOutput.includes('PermissionError')) {
            reject(new Error(`Permission error while installing requirements. Try running VSCode with admin/sudo privileges.`));
          } else if (errorOutput.includes('Connection refused') || errorOutput.includes('network')) {
            reject(new Error(`Network error while installing requirements. Check your internet connection.`));
          } else {
            reject(new Error(`Failed to install requirements. Exit code: ${code}. Error: ${errorOutput}`));
          }
        }
      });
    });
  });
}

async function stopEmbeddingServer(): Promise<void> {
  if (pythonProcess) {
    console.log('[Search++] Stopping embedding server...');
    
    // Use the appropriate method to kill the process based on platform
    if (process.platform === 'win32') {
      childProcess.exec(`taskkill /pid ${pythonProcess.pid} /T /F`);
    } else {
      pythonProcess.kill('SIGTERM');
    }
    
    pythonProcess = undefined;
    serverReady = false;
  }
}

// New getEmbedding implementation that uses the local server
async function getLocalEmbedding(text: string): Promise<number[] | null> {
  if (!serverReady) {
    const started = await startEmbeddingServer(global.extensionContext);
    if (!started) {
      console.error('[Search++] Failed to start embedding server');
      return null;
    }
  }
  
  try {
    console.log(`[Search++] Sending embedding request to local server for text (length: ${text.length})`);
    const res = await fetch(`${SERVER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: text })
    });
    
    const data: EmbeddingResponse = await res.json() as EmbeddingResponse;
    console.log('[Search++] Received embedding response from local server');
    return data?.embedding || null;
  } catch (err) {
    console.error('[Search++] Local embedding error:', err);
    return null;
  }
}

// Updated getEmbedding to use local server instead of OpenAI
async function getEmbedding(text: string, apiKey?: string): Promise<number[] | null> {
  // Switch to local embedding - apiKey parameter is ignored
  return getLocalEmbedding(text);
}

// Replace the indexWorkspace function with this version that uses local embeddings
async function indexWorkspace(apiKey: string): Promise<EmbeddedChunk[]> {
  console.log('[Search++] Indexing full workspace...');
  
  // Make sure server is running
  if (!serverReady) {
    const started = await startEmbeddingServer(global.extensionContext);
    if (!started) {
      vscode.window.showErrorMessage('Search++: Failed to start embedding server. Indexing will not work.');
      return [];
    }
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