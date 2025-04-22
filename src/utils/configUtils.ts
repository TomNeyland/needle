import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/**
 * Gets the OpenAI API key from the following sources in order of precedence:
 * 1. Environment variable (NEEDLE_OPENAI_API_KEY only)
 * 2. VS Code configuration (settings.json)
 * 
 * If no key is found and showPrompt is true, prompts the user to set one.
 */
export async function getOpenAIKey(context: vscode.ExtensionContext, showPrompt: boolean = true): Promise<string | undefined> {
  // Check environment variable - ONLY using the NEEDLE-specific one
  const envApiKey = process.env.NEEDLE_OPENAI_API_KEY;
  if (envApiKey) {
    logger.info('🔍 [Needle] Using API key from NEEDLE_OPENAI_API_KEY environment variable');
    return envApiKey;
  }
  
  // Then check VS Code settings (the recommended way to store user configuration)
  const configApiKey = vscode.workspace.getConfiguration('needle').get<string>('openaiApiKey');
  if (configApiKey) {
    logger.info('🔍 [Needle] Using API key from VS Code settings');
    return configApiKey;
  }

  // For backward compatibility - if there's a key in globalState, migrate it to settings
  // and then remove it from globalState
  const stateApiKey = context.globalState.get<string>('needle.openaiApiKey');
  if (stateApiKey) {
    logger.info('🔍 [Needle] Migrating API key from extension state to VS Code settings');
    await vscode.workspace.getConfiguration('needle').update('openaiApiKey', stateApiKey, vscode.ConfigurationTarget.Global);
    await context.globalState.update('needle.openaiApiKey', undefined);
    return stateApiKey;
  }

  // No API key found - prompt if requested
  if (showPrompt) {
    const response = await vscode.window.showInformationMessage(
      'Needle: OpenAI API Key is required for semantic search.',
      'Set API Key',
      'Create',
      'Dismiss'
    );

    if (response === 'Set API Key') {
      await vscode.commands.executeCommand('needle.setApiKey');
      // Try again after user sets it
      return getOpenAIKey(context, false);
    } else if (response === 'Create') {
      // Open the browser to create an API key
      await vscode.env.openExternal(vscode.Uri.parse('https://platform.openai.com/settings/organization/api-keys'));
      // Then prompt the user to enter it when they come back
      await vscode.commands.executeCommand('needle.setApiKey');
      // Try again after user sets it
      return getOpenAIKey(context, false);
    }
    // If dismissed, leave unset
    return undefined;
  }

  return undefined;
}

export function isWorkspaceReady(): boolean {
  return vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0;
}
