// src/extension.ts
import * as vscode from 'vscode';
// Removed unused imports: fs, path
import { SearchSidebarViewProvider } from './SearchSidebarViewProvider';
import { registerCommands } from './commands/commands';
import { startEmbeddingServer, stopEmbeddingServer } from './embedding/server';
import { setupFileWatcher } from './embedding/indexer';
import { regenerateEmbeddings } from './embedding/regenerator';
import { isWorkspaceReady } from './utils/configUtils'; // Assuming this is where isWorkspaceReady is defined

export const global = { 
  extensionContext: undefined as unknown as vscode.ExtensionContext 
};

let searchSidebarProvider: SearchSidebarViewProvider;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  console.log('🔍 [Search++] Activating extension on ' + process.platform);
  console.log('🔍 [Search++] Extension path: ' + context.extensionPath);

  if (!isWorkspaceReady()) {
    vscode.window.showErrorMessage('Search++: Workspace is not ready. Please open a folder or workspace.');
    return;
  }

  try {
    global.extensionContext = context;

    startEmbeddingServer(context).then(async (started) => {
      if (!started) {
        vscode.window.showErrorMessage('Search++: Failed to start local embedding server. Semantic search will not work.');
      } else {
        // Automatically index the workspace once the server is healthy
        try {
          await vscode.commands.executeCommand('searchpp.regenerateEmbeddings');
          // await vscode.commands.executeCommand('searchpp.regenerateEmbeddings');
          console.log('🔍 [Search++] Workspace indexed successfully on startup.');
        } catch (error) {
          console.error('🔍 [Search++] Failed to index workspace on startup:', error);
        }
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
          await regenerateEmbeddings();
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
