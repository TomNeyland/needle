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
    console.log('[Search++] Embedding server already starting or running');
    return embeddingServerPromise;
  }

  embeddingServerPromise = new Promise<boolean>(async (resolve) => {
    console.log('[Search++] Starting embedding server...');

    const extensionPath = context.extensionPath;
    const scriptPath = path.join(extensionPath, 'src', 'embedding', 'main.py');
    const venvPath = path.join(extensionPath, 'venv');
    const requirementsPath = path.join(extensionPath, 'src', 'embedding', 'requirements.txt');

    // Check if the script and requirements exist
    if (!fs.existsSync(scriptPath) || !fs.existsSync(requirementsPath)) {
      vscode.window.showErrorMessage('Search++: Required files for embedding server are missing.');
      embeddingServerPromise = undefined;
      return resolve(false);
    }

    // Create venv if it doesn't exist
    if (!fs.existsSync(venvPath)) {
      try {
        console.log('[Search++] Creating virtual environment...');
        await createVirtualEnvironment(extensionPath, venvPath);
      } catch (err) {
        console.error('[Search++] Failed to create virtual environment:', err);
        vscode.window.showErrorMessage('Search++: Failed to create Python virtual environment.');
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
        console.log('[Search++] Requirements not found. Installing...');
        await installRequirements(pythonExecutable, requirementsPath);
      }
    } catch (err) {
      console.error('[Search++] Failed to check or install requirements:', err);
      vscode.window.showErrorMessage('Search++: Failed to install Python dependencies.');
      embeddingServerPromise = undefined;
      return resolve(false);
    }

    // Start the Python server with proper environment variables
    console.log(`[Search++] Using Python at: ${pythonExecutable}`);
    console.log(`[Search++] Running script: ${scriptPath}`);

    pythonProcess = childProcess.spawn(pythonExecutable, [scriptPath], {
      cwd: extensionPath,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin') + path.delimiter + process.env.PATH,
        VIRTUAL_ENV: venvPath,
        SERVER_URL: SERVER_URL,
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
      console.error('[Search++] Failed to start embedding server:', err);
      pythonProcess = undefined;
      embeddingServerPromise = undefined;
      resolve(false);
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[Search++] Embedding server exited with code ${code}`);
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
    console.log('[Search++] Stopping embedding server...');
    pythonProcess.kill('SIGTERM');
    pythonProcess = undefined;
  }
}
