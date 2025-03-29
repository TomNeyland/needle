// src/embedding/server.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { setServerReady } from './embeddings';

// Python server process configuration
let pythonProcess: childProcess.ChildProcess | undefined;
const SERVER_PORT = 8000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const HEALTH_CHECK_INTERVAL = 2000; // 2 seconds

/**
 * Starts the Python embedding server
 */
export async function startEmbeddingServer(context: vscode.ExtensionContext): Promise<boolean> {
  if (pythonProcess) {
    console.log('[Search++] Embedding server already running');
    return true;
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
        UVICORN_WORKERS: "15"
      }
    });

    // Add more detailed logging for debugging
    pythonProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`[Embedding Server] ${output}`);
      
      // Check if the output contains a message indicating the server is running
      if (output.includes('Server started') || output.includes('listening on')) {
        setServerReady(true);
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
      setServerReady(false);
      resolve(false);
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[Search++] Embedding server exited with code ${code}`);
      pythonProcess = undefined;
      setServerReady(false);
    });

    // Start health check to determine when server is ready
    let healthCheckAttempts = 0;
    const MAX_HEALTH_CHECK_ATTEMPTS = 30; // 30 attempts with 2-second intervals = 60 seconds max

    const healthCheckInterval = setInterval(async () => {
      try {
        console.log(`[Search++] Attempting health check #${healthCheckAttempts + 1} at ${SERVER_URL}/healthz`);
        const response = await fetch(`${SERVER_URL}/healthz`, { 
          headers: { 'Accept': 'application/json' }
        });
        
        if (response.ok) {
          clearInterval(healthCheckInterval);
          console.log('[Search++] Embedding server ready - health check passed');
          setServerReady(true);
          resolve(true);
        } else {
          console.log(`[Search++] Health check returned status ${response.status}`);
        }
      } catch (err) {
        console.log(`[Search++] Health check failed: ${err}`);
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
                setServerReady(true);
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
      if (!pythonProcess) {
        clearInterval(healthCheckInterval);
        console.error('[Search++] Embedding server failed to start within timeout period');
        resolve(false);
      }
    }, 60000); // 60 seconds timeout
  });
}

/**
 * Stops the Python embedding server
 */
export async function stopEmbeddingServer(): Promise<void> {
  if (pythonProcess) {
    console.log('[Search++] Stopping embedding server...');
    
    // Use the appropriate method to kill the process based on platform
    if (process.platform === 'win32') {
      childProcess.exec(`taskkill /pid ${pythonProcess.pid} /T /F`);
    } else {
      pythonProcess.kill('SIGTERM');
    }
    
    pythonProcess = undefined;
    setServerReady(false);
  }
}

/**
 * Creates a Python virtual environment for the embedding server
 */
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

/**
 * Checks if key requirements are already installed
 */
export async function checkRequirementsInstalled(pythonExecutable: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Try to import a key dependency
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

/**
 * Installs Python package requirements
 */
export async function installRequirements(pythonExecutable: string, requirementsPath: string): Promise<void> {
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
          reject(new Error(`Failed to install requirements with system pip: ${(installError as any).message || installError}`));
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