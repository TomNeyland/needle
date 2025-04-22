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
  Failed = 'failed'
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
    SERVER_URL = `http://localhost:${SERVER_PORT}`;
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

    // Create venv if it doesn't exist
    if (!fs.existsSync(venvPath)) {
      try {
        logger.info('Creating virtual environment...');
        // Show setup notification
        showSetupNotification('Setting up Needle embedding server...');
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
        // Show setup notification for installing dependencies
        showSetupNotification('Installing Needle\'s required dependencies (this may take a few minutes)...');
        await installRequirements(pythonExecutable, requirementsPath);
        // Hide notification after dependencies are installed
        hideSetupNotification();
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
        resolve(true);
      }
    });

    pythonProcess.stderr?.on('data', (data) => {
      const errorMsg = data.toString().trim();
      logger.error(`[Embedding Server Error] ${errorMsg}`);

      // Check if the output contains a message indicating the server is running
      if (errorMsg.includes('Application startup complete.')) {
        // Update server status to Ready
        currentServerStatus = ServerStatus.Ready;
        serverStatusEmitter.fire(ServerStatus.Ready);
        resolve(true);
      }

      // Check if the output contains an exit message
      if (errorMsg.toLowerCase().includes('exit')) {
        // Update server status to Failed
        currentServerStatus = ServerStatus.Failed;
        serverStatusEmitter.fire(ServerStatus.Failed);
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
function showSetupNotification(message: string): void {
  // Dispose existing notification if it exists
  if (setupNotification) {
    setupNotification.dispose();
  }
  
  // Create a new status bar item
  setupNotification = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
  setupNotification.text = `$(sync~spin) Needle: ${message}`;
  setupNotification.tooltip = 'Needle is setting up required components for semantic search';
  setupNotification.show();
  
  // Also show an information message that doesn't block the UI
  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Needle: ${message}`,
    cancellable: false
  }, () => {
    // Return a promise that never resolves while the setup is in progress
    return new Promise<void>(resolve => {
      // The promise will be manually resolved when hideSetupNotification is called
    });
  });
}

/**
 * Hides the setup notification and shows a success message
 */
function hideSetupNotification(): void {
  if (setupNotification) {
    setupNotification.dispose();
    setupNotification = undefined;
    
    // Show a happy success message that will auto-dismiss after 10 seconds
    const successNotification = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
    successNotification.text = `$(check) $(heart) Needle is ready to go!`;
    successNotification.tooltip = 'Needle setup completed successfully';
    successNotification.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    successNotification.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
    successNotification.show();
    
    // Show a non-blocking visual notification with a celebratory look
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "✨ Needle is ready for semantic search! ✨",
      cancellable: false
    }, (progress) => {
      // Add a visual indicator of success with progress
      for (let i = 0; i < 10; i++) {
        setTimeout(() => {
          progress.report({ 
            increment: 10, 
            message: "🔍 " + "🎉 ".repeat(i % 3 + 1)
          });
        }, i * 1000);
      }
      
      // Auto-dismiss after 10 seconds
      return new Promise<void>(resolve => {
        setTimeout(() => {
          successNotification.dispose();
          resolve();
        }, 10000);
      });
    });
  }
}
