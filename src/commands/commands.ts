// src/commands.ts
import * as vscode from 'vscode';
import { performSearch } from '../search/performSearch';
import { regenerateEmbeddings } from '../embedding/regenerator';
import { getOpenAIKey } from '../utils/configUtils';

export function registerCommands(context: vscode.ExtensionContext) {
  // Register the command to set the API key
  const setApiKeyCommand = vscode.commands.registerCommand('needle.setApiKey', async () => {
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Enter your OpenAI API Key',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...'
    });
    
    if (apiKey) {
      await context.globalState.update('needle.openaiApiKey', apiKey);
      vscode.window.showInformationMessage('Needle: API Key saved successfully');
    }
  });

  context.subscriptions.push(setApiKeyCommand);

  // Register the smart find command
  const smartFindCommand = vscode.commands.registerCommand('needle.smartFind', async (query?: string) => {
    if (!query) {
      query = await vscode.window.showInputBox({
        prompt: 'Needle: What are you looking for?',
        placeHolder: 'e.g., Where do we validate user input?'
      });
    }

    if (!query) {
      vscode.window.showWarningMessage('Needle: No query entered.');
      return;
    }

    // Focus the sidebar view if it exists
    vscode.commands.executeCommand('needle.sidebar.focus');
    
    // Perform the search
    const results = await vscode.commands.executeCommand('needle.performSearch', query);
    
    // The results will be displayed in the sidebar by the performSearch command
  });

  context.subscriptions.push(smartFindCommand);

  // Register the performSearch command
  const performSearchCommand = vscode.commands.registerCommand('needle.performSearch', async (query: string, exclusionPattern: string = '') => {
    console.log(`[Needle] Command received: performSearch with query "${query}" and exclusion "${exclusionPattern}"`);
    return await performSearch(query, exclusionPattern);
  });

  context.subscriptions.push(performSearchCommand);
}
