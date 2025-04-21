// src/embedding/server.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { createVirtualEnvironment, checkRequirementsInstalled, installRequirements } from './pythonUtils';

// Python server process configuration
let pythonProcess: childProcess.ChildProcess | undefined;
const SERVER_PORT = 8000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
let embeddingServerPromise: Promise<boolean> | undefined;

/**
 * Starts the Python embedding server
 */
export async function startEmbeddingServer(context: vscode.ExtensionContext): Promise<boolean> {
  if (embeddingServerPromise) {
    console.log('[Needle] Embedding server already starting or running');
    return embeddingServerPromise;
  }

  embeddingServerPromise = new Promise<boolean>(async (resolve) => {
    console.log('[Needle] Starting embedding server...');

    const extensionPath = context.extensionPath;
    const scriptPath = path.join(extensionPath, 'src', 'embedding', 'main.py');
    const venvPath = path.join(extensionPath, '.venv');
    const requirementsPath = path.join(extensionPath, 'src', 'embedding', 'requirements.txt');

    // Check if the script and requirements exist
    if (!fs.existsSync(scriptPath) || !fs.existsSync(requirementsPath)) {
      vscode.window.showErrorMessage('Needle: Required files for embedding server are missing.');
      embeddingServerPromise = undefined;
      return resolve(false);
    }

    // Create venv if it doesn't exist
    if (!fs.existsSync(venvPath)) {
      try {
        console.log('[Needle] Creating virtual environment...');
        await createVirtualEnvironment(extensionPath, venvPath);
      } catch (err) {
        console.error('[Needle] Failed to create virtual environment:', err);
        vscode.window.showErrorMessage('Needle: Failed to create Python virtual environment.');
        embeddingServerPromise = undefined;
        return resolve(false);
      }
    }

    // Determine the Python executable path
    const pythonExecutable = path.join(
      venvPath,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python'
    );

    // Check and install requirements if necessary
    try {
      const requirementsInstalled = await checkRequirementsInstalled(pythonExecutable);
      if (!requirementsInstalled) {
        console.log('[Needle] Requirements not found. Installing...');
        await installRequirements(pythonExecutable, requirementsPath);
      }
    } catch (err) {
      console.error('[Needle] Failed to check or install requirements:', err);
      vscode.window.showErrorMessage('Needle: Failed to install Python dependencies.');
      embeddingServerPromise = undefined;
      return resolve(false);
    }

    // Start the Python server with proper environment variables
    console.log(`[Needle] Using Python at: ${pythonExecutable}`);
    console.log(`[Needle] Running script: ${scriptPath}`);

    // Get the API key from config or global state
    let needleApiKey = process.env.NEEDLE_OPENAI_API_KEY;
    if (!needleApiKey && context.globalState) {
      needleApiKey = context.globalState.get('needle.openaiApiKey') as string | undefined;
    }

    pythonProcess = childProcess.spawn(pythonExecutable, [scriptPath], {
      cwd: extensionPath,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin') + path.delimiter + process.env.PATH,
        VIRTUAL_ENV: venvPath,
        SERVER_URL: SERVER_URL,
        NEEDLE_OPENAI_API_KEY: needleApiKey || '',
      }
    });

    pythonProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      console.log(`[Embedding Server] ${output}`);

      // Check if the output contains a message indicating the server is running
      if (output.includes('Application startup complete')) {
        resolve(true);
      }
    });

    pythonProcess.stderr?.on('data', (data) => {
      const errorMsg = data.toString().trim();
      console.error(`[Embedding Server Error] ${errorMsg}`);

      // Check if the output contains a message indicating the server is running
      if (errorMsg.includes('Application startup complete.')) {
        resolve(true);
      }

      // Check if the output contains an exit message
      if (errorMsg.toLowerCase().includes('exit')) {
        resolve(false);
      }
    });

    pythonProcess.on('error', (err) => {
      console.error('[Needle] Failed to start embedding server:', err);
      pythonProcess = undefined;
      embeddingServerPromise = undefined;
      resolve(false);
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[Needle] Embedding server exited with code ${code}`);
      pythonProcess = undefined;
      embeddingServerPromise = undefined;
    });
  });

  return embeddingServerPromise;
}

/**
 * Stops the Python embedding server
 */
export async function stopEmbeddingServer(): Promise<void> {
  if (pythonProcess) {
    console.log('[Needle] Stopping embedding server...');
    pythonProcess.kill('SIGTERM');
    pythonProcess = undefined;
  }
}
