import * as vscode from 'vscode';
import { startEmbeddingServer } from './server';
import { updateFileEmbeddings } from './indexer';
import { collectDocumentsFromWorkspace } from '../utils/embeddingUtils';
import * as path from 'path';
import { global } from '../extension';

/**
 * Forces a regeneration of the embeddings cache file
 */
export async function regenerateEmbeddings(exclusionPattern: string = ''): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    throw new Error('No workspace folder open.');
  }

  console.log('[Search++] Starting full re-indexing...');

  // Ensure the server is ready
  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    throw new Error('Failed to start embedding server.');
  }

  // Re-index the workspace and collect documents
  let documents = await collectDocumentsFromWorkspace();
  // for some reason not all documents are returned the first time
  // TODO: fix this
  documents = await collectDocumentsFromWorkspace();

  console.log(`[Search++] Collected ${documents.length} documents for re-embedding.`);
  if (documents.length > 0) {
    await updateFileEmbeddings(documents); // Send all documents to the backend
    console.log('[Search++] Successfully re-embedded the entire workspace.');
  } else {
    console.log('[Search++] No documents to re-embed.');
  }
}