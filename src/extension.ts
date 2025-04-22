// src/extension.ts
import * as vscode from 'vscode';
// Removed unused imports: fs, path
import { SearchSidebarViewProvider } from './SearchSidebarViewProvider';
import { registerCommands } from './commands/commands';
import { startEmbeddingServer, stopEmbeddingServer } from './embedding/server';
import { setupFileWatcher } from './embedding/indexer';
import { regenerateEmbeddings } from './embedding/regenerator';
import { isWorkspaceReady, getOpenAIKey } from './utils/configUtils';
import { logger } from './utils/logger';

export const global = { 
  extensionContext: undefined as unknown as vscode.ExtensionContext 
};

let searchSidebarProvider: SearchSidebarViewProvider;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  logger.info('Activating extension on ' + process.platform);
  logger.info('Extension path: ' + context.extensionPath);

  if (!isWorkspaceReady()) {
    vscode.window.showErrorMessage('Needle: Workspace is not ready. Please open a folder or workspace.');
    return;
  }

  try {
    global.extensionContext = context;

    // Check for API key first and show notification if not set
    getOpenAIKey(context, false).then(async (apiKey) => {
      logger.info('API Key status:', apiKey ? 'Available' : 'Not set');
      
      // If API key is not set, show a non-modal notification
      if (!apiKey) {
        const setKeyAction = 'Set API Key';
        const dismissAction = 'Dismiss';
        
        // Show a non-modal notification 
        vscode.window.showInformationMessage(
          'Needle needs an OpenAI API key to enable semantic search.',
          setKeyAction,
          dismissAction
        ).then(async (selection) => {
          if (selection === setKeyAction) {
            await vscode.commands.executeCommand('needle.setApiKey');
          }
        });
        
        // Add a persistent status bar item
        const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
        statusItem.text = "$(key) Set API Key";
        statusItem.tooltip = "Set OpenAI API Key for Needle";
        statusItem.command = "needle.setApiKey";
        statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusItem.show();
        
        // Keep it visible for 2 minutes to give user time to notice it
        setTimeout(() => {
          statusItem.dispose();
        }, 120000);
      }
      
      // Start the server - it will use the API key from context even if undefined
      startEmbeddingServer(context).then(async (started) => {
        if (!started) {
          vscode.window.showErrorMessage('Needle: Failed to start local embedding server. Semantic search will not work.');
        } else {
          // Automatically index the workspace once the server is healthy
          try {
            await vscode.commands.executeCommand('needle.regenerateEmbeddings');
            logger.info('Workspace indexed successfully on startup.');
          } catch (error) {
            logger.error('Failed to index workspace on startup:', error);
          }
        }
      });
    });

    setupFileWatcher(context);

    searchSidebarProvider = new SearchSidebarViewProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('needle.sidebar', searchSidebarProvider)
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(search) Needle";
    statusBarItem.tooltip = "Click to open Needle";
    statusBarItem.command = "needle.smartFind";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    registerCommands(context);

    context.subscriptions.push(
      vscode.commands.registerCommand('needle.regenerateEmbeddings', async (exclusionPattern: string = '') => {
        try {
          // Check for API key before regenerating embeddings
          const apiKey = await getOpenAIKey(context);
          if (!apiKey) {
            logger.info('🔍 [Needle] No API key available for regenerating embeddings');
            return;
          }
          
          await regenerateEmbeddings(exclusionPattern);
        } catch (error) {
          vscode.window.showErrorMessage(`Needle: Failed to regenerate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      })
    );

    logger.info('🔍 [Needle] Extension activated successfully');
  } catch (error) {
    vscode.window.showErrorMessage('Needle: Error activating extension: ' + error);
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  stopEmbeddingServer().catch(err => {
    logger.error('[Needle] Error stopping embedding server:', err);
  });
}
