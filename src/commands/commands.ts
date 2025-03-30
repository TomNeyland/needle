// src/commands.ts
import * as vscode from 'vscode';
import { performSearch } from '../search/performSearch';
import { regenerateEmbeddings } from '../embedding/regenerator';
import { getOpenAIKey } from '../utils/configUtils';

export function registerCommands(context: vscode.ExtensionContext) {
  // Register the command to set the API key
  const setApiKeyCommand = vscode.commands.registerCommand('searchpp.setApiKey', async () => {
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Enter your OpenAI API Key',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...'
    });
    
    if (apiKey) {
      await context.globalState.update('searchpp.openaiApiKey', apiKey);
      vscode.window.showInformationMessage('Search++: API Key saved successfully');
    }
  });

  context.subscriptions.push(setApiKeyCommand);

  // Register the smart find command
  const smartFindCommand = vscode.commands.registerCommand('searchpp.smartFind', async (query?: string) => {
    if (!query) {
      query = await vscode.window.showInputBox({
        prompt: 'Search++: What are you looking for?',
        placeHolder: 'e.g., Where do we validate user input?'
      });
    }

    if (!query) {
      vscode.window.showWarningMessage('Search++: No query entered.');
      return;
    }

    // Focus the sidebar view if it exists
    vscode.commands.executeCommand('searchpp.sidebar.focus');
    
    // Perform the search
    const results = await vscode.commands.executeCommand('searchpp.performSearch', query);
    
    // The results will be displayed in the sidebar by the performSearch command
  });

  context.subscriptions.push(smartFindCommand);

  // Register the performSearch command
  const performSearchCommand = vscode.commands.registerCommand('searchpp.performSearch', async (query: string, exclusionPattern: string = '') => {
    console.log(`[Search++] Command received: performSearch with query "${query}" and exclusion "${exclusionPattern}"`);
    return await performSearch(query, exclusionPattern);
  });

  context.subscriptions.push(performSearchCommand);
}
