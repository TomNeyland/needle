// src/commands.ts
import * as vscode from 'vscode';
import { performSearch } from '../search/performSearch';
import { regenerateEmbeddings } from '../embedding/regenerator';
import { getOpenAIKey } from '../utils/configUtils';
import { logger } from '../utils/logger';

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
      // Store in VS Code settings (recommended approach)
      await vscode.workspace.getConfiguration('needle').update('openaiApiKey', apiKey, vscode.ConfigurationTarget.Global);
      
      // Show success message with reload option
      const reload = await vscode.window.showInformationMessage(
        'Needle: API Key saved successfully. Reload VS Code window to apply changes?', 
        'Reload',
        'Later'
      );
      
      if (reload === 'Reload') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  });

  context.subscriptions.push(setApiKeyCommand);

  // Register the command to clear the API key (for testing)
  const clearApiKeyCommand = vscode.commands.registerCommand('needle.clearApiKey', async () => {
    // Clear from VS Code settings
    await vscode.workspace.getConfiguration('needle').update('openaiApiKey', undefined, vscode.ConfigurationTarget.Global);
    // Also clear from extension state for backward compatibility
    await context.globalState.update('needle.openaiApiKey', undefined);
    
    // Check if the environment variable is set
    const envKeyPresent = process.env.NEEDLE_OPENAI_API_KEY;
    if (envKeyPresent) {
      vscode.window.showWarningMessage(
        'Needle: API Key cleared from settings, but NEEDLE_OPENAI_API_KEY environment variable is still providing a key. ' +
        'To completely clear the key, remove this environment variable.'
      );
    } else {
      vscode.window.showInformationMessage('Needle: API Key has been cleared. You will be prompted to set it when needed.');
    }
    
    // Force VS Code to reload the window to ensure the change takes effect
    const reload = await vscode.window.showInformationMessage(
      'Reload VS Code window to apply changes?', 
      'Reload'
    );
    
    if (reload === 'Reload') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  });
  
  context.subscriptions.push(clearApiKeyCommand);

  // Register the command to get the API key (used by sidebar view and other components)
  const getApiKeyCommand = vscode.commands.registerCommand('needle.getOpenAIKey', async () => {
    return await getOpenAIKey(context);
  });
  
  context.subscriptions.push(getApiKeyCommand);

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
    logger.info(`[Needle] Command received: performSearch with query "${query}" and exclusion "${exclusionPattern}"`);
    return await performSearch(query, exclusionPattern);
  });

  context.subscriptions.push(performSearchCommand);
}
