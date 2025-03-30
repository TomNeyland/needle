// src/extension.ts
import * as vscode from 'vscode';
// Removed unused imports: fs, path
import { SearchSidebarViewProvider } from './SearchSidebarViewProvider';
import { registerCommands } from './commands/commands';
import { startEmbeddingServer, stopEmbeddingServer } from './embedding/server';
import { setupFileWatcher } from './embedding/indexer';
import { regenerateEmbeddings } from './embedding/regenerator';

export const global = { 
  extensionContext: undefined as unknown as vscode.ExtensionContext 
};

let searchSidebarProvider: SearchSidebarViewProvider;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('🔍 [Search++] Activating extension on ' + process.platform);
  console.log('🔍 [Search++] Extension path: ' + context.extensionPath);

  try {
    global.extensionContext = context;

    startEmbeddingServer(context).then(started => {
      if (!started) {
        vscode.window.showErrorMessage('Search++: Failed to start local embedding server. Semantic search will not work.');
      }
    });

    setupFileWatcher(context);

    searchSidebarProvider = new SearchSidebarViewProvider(context);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('searchpp.sidebar', searchSidebarProvider)
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(search) Search++";
    statusBarItem.tooltip = "Click to open Search++";
    statusBarItem.command = "searchpp.smartFind";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    registerCommands(context);

    context.subscriptions.push(
      vscode.commands.registerCommand('searchpp.regenerateEmbeddings', async (exclusionPattern: string = '') => {
        try {
          await regenerateEmbeddings(exclusionPattern);
        } catch (error) {
          vscode.window.showErrorMessage(`Search++: Failed to regenerate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      })
    );

    console.log('🔍 [Search++] Extension activated successfully');
  } catch (error) {
    vscode.window.showErrorMessage('Search++: Error activating extension: ' + error);
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  stopEmbeddingServer().catch(err => {
    console.error('[Search++] Error stopping embedding server:', err);
  });
}
