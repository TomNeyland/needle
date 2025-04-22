// src/embedding/server.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as childProcess from 'child_process';
import { createVirtualEnvironment, checkRequirementsInstalled, installRequirements } from './pythonUtils';
import { getOpenAIKey } from '../utils/configUtils';
import { logger } from '../utils/logger';
import { findAvailablePort } from '../utils/portUtils';

// Python server process configuration
let pythonProcess: childProcess.ChildProcess | undefined;
export let SERVER_PORT = 8000; // Default port, will be dynamically assigned
export let SERVER_URL = `http://localhost:${SERVER_PORT}`; // Will be updated when port is assigned
let embeddingServerPromise: Promise<boolean> | undefined;
// Track setup notification
let setupNotification: vscode.StatusBarItem | undefined;

// Server status that can be accessed from other modules
export enum ServerStatus {
  NotStarted = 'not_started',
  Starting = 'starting',
  Ready = 'ready',
  Failed = 'failed',
  Indexing = 'indexing'
}

export let currentServerStatus: ServerStatus = ServerStatus.NotStarted;

// Event emitter for server status changes
export const serverStatusEmitter = new vscode.EventEmitter<ServerStatus>();
export const onServerStatusChanged = serverStatusEmitter.event;

/**
 * Starts the Python embedding server
 */
export async function startEmbeddingServer(context: vscode.ExtensionContext): Promise<boolean> {
  if (embeddingServerPromise) {
    logger.info('Embedding server already starting or running');
    return embeddingServerPromise;
  }

  // Update server status to Starting
  currentServerStatus = ServerStatus.Starting;
  serverStatusEmitter.fire(ServerStatus.Starting);

  // Find an available port
  try {
    SERVER_PORT = await findAvailablePort();
    SERVER_URL = `http://127.0.0.2:${SERVER_PORT}`;
    logger.info(`[Needle] Found available port: ${SERVER_PORT}`);
  } catch (err) {
    logger.error(`[Needle] Error finding available port: ${err}`);
    vscode.window.showErrorMessage('Needle: Failed to find an available port for the embedding server.');
    return false;
  }

  embeddingServerPromise = new Promise<boolean>(async (resolve) => {
    logger.info(`Starting embedding server on port ${SERVER_PORT}...`);

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

    // Show setup notification at the beginning of the process
    showSetupNotification('Setting up Needle embedding server...');

    // Create venv if it doesn't exist
    if (!fs.existsSync(venvPath)) {
      try {
        logger.info('Creating virtual environment...');
        await createVirtualEnvironment(extensionPath, venvPath);
      } catch (err) {
        // Hide notification if there was an error
        hideSetupNotification();
        logger.error('Failed to create virtual environment:', err);
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
        logger.info('Requirements not found. Installing...');
        // Update setup notification for installing dependencies
        showSetupNotification('Installing Needle\'s required dependencies (this may take a few minutes)...');
        await installRequirements(pythonExecutable, requirementsPath);
      }
    } catch (err) {
      // Hide notification if there was an error
      hideSetupNotification();
      logger.error('Failed to check or install requirements:', err);
      vscode.window.showErrorMessage('Needle: Failed to install Python dependencies.');
      embeddingServerPromise = undefined;
      return resolve(false);
    }

    // Start the Python server with proper environment variables
    logger.info(`Using Python at: ${pythonExecutable}`);
    logger.info(`Running script: ${scriptPath}`);
    
    // Update setup notification for starting server
    showSetupNotification('Starting Needle server...');

    // Get the API key using our consistent method
    let needleApiKey = await getOpenAIKey(context, false);
    logger.info(`API key available for server: ${needleApiKey ? 'Yes' : 'No'}`);

    pythonProcess = childProcess.spawn(pythonExecutable, [scriptPath], {
      cwd: extensionPath,
      stdio: 'pipe',
      env: {
        ...process.env,
        PATH: path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin') + path.delimiter + process.env.PATH,
        VIRTUAL_ENV: venvPath,
        SERVER_URL: SERVER_URL,
        NEEDLE_SERVER_PORT: SERVER_PORT.toString(), // Pass the dynamic port to Python
        NEEDLE_OPENAI_API_KEY: needleApiKey || '',
      }
    });

    pythonProcess.stdout?.on('data', (data) => {
      const output = data.toString().trim();
      logger.info(`[Embedding Server] ${output}`);

      // Check if the output contains a message indicating the server is running
      if (output.includes('Application startup complete')) {
        // Update server status to Ready
        currentServerStatus = ServerStatus.Ready;
        serverStatusEmitter.fire(ServerStatus.Ready);
        // Hide the setup notification now that server is ready
        hideSetupNotification();
        resolve(true);
      }
    });

    pythonProcess.stderr?.on('data', (data) => {
      const errorMsg = data.toString().trim();
      logger.error(`[Embedding Server Error] ${errorMsg}`);

      // Check if the output contains a message indicating the server is running
      if (errorMsg.includes('Application startup complete')) {
        // Update server status to Ready
        currentServerStatus = ServerStatus.Ready;
        serverStatusEmitter.fire(ServerStatus.Ready);
        // Hide the setup notification now that server is ready
        hideSetupNotification();
        resolve(true);
      }

      // Check if the output contains an exit message
      if (errorMsg.toLowerCase().includes('exit')) {
        // Update server status to Failed
        currentServerStatus = ServerStatus.Failed;
        serverStatusEmitter.fire(ServerStatus.Failed);
        hideSetupNotification();
        resolve(false);
      }
    });

    pythonProcess.on('error', (err) => {
      logger.error('Failed to start embedding server:', err);
      pythonProcess = undefined;
      embeddingServerPromise = undefined;
      // Update server status to Failed
      currentServerStatus = ServerStatus.Failed;
      serverStatusEmitter.fire(ServerStatus.Failed);
      resolve(false);
    });

    pythonProcess.on('exit', (code) => {
      // Hide notification if server exits
      hideSetupNotification();
      logger.info(`Embedding server exited with code ${code}`);
      pythonProcess = undefined;
      embeddingServerPromise = undefined;
      // Update server status to NotStarted
      currentServerStatus = ServerStatus.NotStarted;
      serverStatusEmitter.fire(ServerStatus.NotStarted);
    });
  });

  return embeddingServerPromise;
}

/**
 * Stops the Python embedding server
 */
export async function stopEmbeddingServer(): Promise<void> {
  if (pythonProcess) {
    logger.info('Stopping embedding server...');
    pythonProcess.kill('SIGTERM');
    pythonProcess = undefined;
  }
}

/**
 * Shows a status bar notification during first-time setup
 */
// Track the progress notification resolve function
let progressResolve: ((value: void) => void) | undefined;

function showSetupNotification(message: string): void {
  // Notifications disabled - just log the message
  logger.info(`Setup notification (disabled): ${message}`);
  
  // Clear any existing notification
  if (setupNotification) {
    setupNotification.dispose();
    setupNotification = undefined;
  }
  
  // Clean up any existing progress resolve
  if (progressResolve) {
    progressResolve();
    progressResolve = undefined;
  }
}

/**
 * Hides the setup notification and shows a success message
 */
function hideSetupNotification(): void {
  // Resolve any pending progress notification
  if (progressResolve) {
    progressResolve();
    progressResolve = undefined;
  }
  
  if (setupNotification) {
    setupNotification.dispose();
    setupNotification = undefined;
  }
  
  // Log that we would have shown a success message
  logger.info('Needle setup completed (success notification disabled)');
}
