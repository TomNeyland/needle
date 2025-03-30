import * as vscode from 'vscode';

export async function getOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const apiKey = context.globalState.get<string>('searchpp.openaiApiKey');
  const envApiKey = process.env.OPENAI_API_KEY;

  if (!apiKey && !envApiKey) {
    const response = await vscode.window.showInformationMessage(
      'Search++: OpenAI API Key is required for semantic search.',
      'Set API Key',
      'Cancel'
    );

    if (response === 'Set API Key') {
      return vscode.commands.executeCommand('searchpp.setApiKey');
    }

    return undefined;
  }

  return apiKey || envApiKey;
}

export function isWorkspaceReady(): boolean {
  return vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0;
}
