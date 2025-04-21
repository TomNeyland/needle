import * as vscode from 'vscode';

export async function getOpenAIKey(context: vscode.ExtensionContext, showPrompt: boolean = true): Promise<string | undefined> {
  // Prefer explicit env var if set
  const envApiKey = process.env.NEEDLE_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const apiKey = context.globalState.get<string>('needle.openaiApiKey');

  if (!apiKey && !envApiKey && showPrompt) {
    const response = await vscode.window.showInformationMessage(
      'Needle: OpenAI API Key is required for semantic search.',
      'Set API Key',
      'Dismiss'
    );

    if (response === 'Set API Key') {
      await vscode.commands.executeCommand('needle.setApiKey');
      // Try again after user sets it
      return context.globalState.get<string>('needle.openaiApiKey') || undefined;
    }
    // If dismissed, leave unset
    return undefined;
  }

  return apiKey || envApiKey;
}

export function isWorkspaceReady(): boolean {
  return vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0;
}
