import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { indexWorkspace } from './indexer';
import { EmbeddedChunk } from '../utils/embeddingUtils';

const EMBEDDING_FILE = 'searchpp.embeddings.json';

/**
 * Regenerates all embeddings by deleting the current file and reindexing the workspace
 * @returns A promise that resolves to true if regeneration was successful
 */
export async function regenerateEmbeddings(): Promise<boolean> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage('Search++: No workspace folder is open');
    return false;
  }

  const workspacePath = workspaceFolders[0].uri.fsPath;
  const embeddingPath = path.join(workspacePath, EMBEDDING_FILE);

  try {
    // Delete existing embeddings file if it exists
    if (fs.existsSync(embeddingPath)) {
      console.log(`[Search++] Deleting existing embeddings file at ${embeddingPath}`);
      fs.unlinkSync(embeddingPath);
    }

    // Show progress notification
    return await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Search++: Regenerating embeddings...',
      cancellable: false
    }, async (progress) => {
      progress.report({ message: 'Indexing workspace...' });
      
      // Get API key (empty string, as indexWorkspace should handle this)
      const apiKey = '';
      const embeddedChunks = await indexWorkspace(apiKey);
      
      if (embeddedChunks.length === 0) {
        vscode.window.showWarningMessage('Search++: No files were indexed');
        return false;
      }
      
      progress.report({ message: 'Saving embeddings...' });
      fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
      
      vscode.window.showInformationMessage(`Search++: Successfully regenerated ${embeddedChunks.length} embeddings`);
      console.log(`[Search++] Successfully regenerated ${embeddedChunks.length} embeddings`);
      
      return true;
    });
  } catch (error) {
    console.error('[Search++] Error regenerating embeddings:', error);
    vscode.window.showErrorMessage(`Search++: Failed to regenerate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}
