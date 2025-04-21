// src/extension.ts
import * as vscode from 'vscode';
// Removed unused imports: fs, path
import { SearchSidebarViewProvider } from './SearchSidebarViewProvider';
import { registerCommands } from './commands/commands';
import { startEmbeddingServer, stopEmbeddingServer } from './embedding/server';
import { setupFileWatcher } from './embedding/indexer';
import { regenerateEmbeddings } from './embedding/regenerator';
import { isWorkspaceReady, getOpenAIKey } from './utils/configUtils';

export const global = { 
  extensionContext: undefined as unknown as vscode.ExtensionContext 
};

let searchSidebarProvider: SearchSidebarViewProvider;
let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  console.log('🔍 [Needle] Activating extension on ' + process.platform);
  console.log('🔍 [Needle] Extension path: ' + context.extensionPath);

  if (!isWorkspaceReady()) {
    vscode.window.showErrorMessage('Needle: Workspace is not ready. Please open a folder or workspace.');
    return;
  }

  try {
    global.extensionContext = context;

    // Check for API key first and show notification if not set
    getOpenAIKey(context, false).then(async (apiKey) => {
      console.log('🔍 [Needle] API Key status:', apiKey ? 'Available' : 'Not set');
      
      // If API key is not set, show a notification in the bottom right
      if (!apiKey) {
        const setKeyAction = 'Set API Key';
        const dismissAction = 'Dismiss';
        
        // Use the modal option to ensure it's prominently displayed
        const notification = await vscode.window.showInformationMessage(
          'Needle needs an OpenAI API key to enable semantic search.',
          { modal: true },
          setKeyAction,
          dismissAction
        );
        
        if (notification === setKeyAction) {
          await vscode.commands.executeCommand('needle.setApiKey');
        }
        
        // Also add a status bar notification that persists
        const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
        statusItem.text = "$(key) Set API Key";
        statusItem.tooltip = "Set OpenAI API Key for Needle";
        statusItem.command = "needle.setApiKey";
        statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusItem.show();
        
        // Keep it visible for 1 minute
        setTimeout(() => {
          statusItem.dispose();
        }, 60000);
      }
      
      // Start the server - it will use the API key from context even if undefined
      startEmbeddingServer(context).then(async (started) => {
        if (!started) {
          vscode.window.showErrorMessage('Needle: Failed to start local embedding server. Semantic search will not work.');
        } else {
          // Automatically index the workspace once the server is healthy
          try {
            await vscode.commands.executeCommand('needle.regenerateEmbeddings');
            console.log('🔍 [Needle] Workspace indexed successfully on startup.');
          } catch (error) {
            console.error('🔍 [Needle] Failed to index workspace on startup:', error);
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
            console.log('🔍 [Needle] No API key available for regenerating embeddings');
            return;
          }
          
          await regenerateEmbeddings(exclusionPattern);
        } catch (error) {
          vscode.window.showErrorMessage(`Needle: Failed to regenerate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      })
    );

    const config = vscode.workspace.getConfiguration('needle');
    const apiKey = config.get<string>('openaiApiKey');
  
    if (!apiKey) {
      const setKey = await vscode.window.showInformationMessage(
        'Needle: No OpenAI API key found. Would you like to set one now?',
        'Set API Key'
      );
  
      if (setKey === 'Set API Key') {
        const userInput = await vscode.window.showInputBox({
          prompt: 'Enter your OpenAI API key',
          ignoreFocusOut: true,
          password: true,
        });
  
        if (userInput) {
          await config.update('openaiApiKey', userInput, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('✅ API key saved successfully.');
        }
      }
    }

    console.log('🔍 [Needle] Extension activated successfully');
  } catch (error) {
    vscode.window.showErrorMessage('Needle: Error activating extension: ' + error);
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  stopEmbeddingServer().catch(err => {
    console.error('[Needle] Error stopping embedding server:', err);
  });
}
