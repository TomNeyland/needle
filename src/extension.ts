// src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SearchSidebarViewProvider } from './SearchSidebarViewProvider';
import { registerCommands } from './commands/commands';
import { startEmbeddingServer, stopEmbeddingServer } from './embedding/server';
import { setupFileWatcher } from './embedding/indexer';
import { regenerateEmbeddings } from './embedding/regenerator'; // Assuming this is the correct import

// Global extension context for use in other modules
export const global = { 
  extensionContext: undefined as unknown as vscode.ExtensionContext 
};

let searchSidebarProvider: SearchSidebarViewProvider;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('🔍 [Search++] Activating extension on ' + process.platform);
  console.log('🔍 [Search++] Extension path: ' + context.extensionPath);

  try {
    // Store context globally for use in other modules
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

    // Set up file watcher for reindexing on save
    setupFileWatcher(context);
    
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

    // Register all extension commands
    registerCommands(context);

    // Register the regenerateEmbeddings command
    context.subscriptions.push(
      vscode.commands.registerCommand('searchpp.regenerateEmbeddings', async (exclusionPattern: string = '') => {
        try {
          console.log(`[Search++] Command received: regenerateEmbeddings with exclusion pattern "${exclusionPattern}"`);
          // Make sure the exclusion pattern is explicitly passed to the function
          const success = await regenerateEmbeddings(exclusionPattern);
          return success;
        } catch (error) {
          vscode.window.showErrorMessage(`Search++: Failed to regenerate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
          throw error;
        }
      })
    );

    console.log('🔍 [Search++] Extension activated successfully');
  } catch (error) {
    console.error('🔍 [Search++] Error activating extension:', error);
    vscode.window.showErrorMessage('Search++: Error activating extension: ' + error);
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  
  // Stop the embedding server when extension deactivates
  stopEmbeddingServer().catch(err => {
    console.error('[Search++] Error stopping embedding server:', err);
  });
}
