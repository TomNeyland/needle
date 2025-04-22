import * as vscode from 'vscode';
import { startEmbeddingServer, ServerStatus, currentServerStatus, serverStatusEmitter } from './server';
import { updateFileEmbeddings } from './indexer';
import { collectDocumentsFromWorkspace } from '../utils/embeddingUtils';
import * as path from 'path';
import { global } from '../extension';
import { logger } from '../utils/logger';

/**
 * Forces a regeneration of the embeddings cache file
 */
export async function regenerateEmbeddings(exclusionPattern: string = ''): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    throw new Error('No workspace folder open.');
  }

  logger.info('[Needle] Starting full re-indexing...');

  // Ensure the server is ready
  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    throw new Error('Failed to start embedding server.');
  }
  
  // Update server status to indexing
  serverStatusEmitter.fire(ServerStatus.Indexing);

  // Re-index the workspace and collect documents
  let documents = await collectDocumentsFromWorkspace();
  // for some reason not all documents are returned the first time
  // TODO: fix this
  documents = await collectDocumentsFromWorkspace();

  logger.info(`[Needle] Collected ${documents.length} documents for re-embedding.`);
  if (documents.length > 0) {
    await updateFileEmbeddings(documents); // Send all documents to the backend
    logger.info('[Needle] Successfully re-embedded the entire workspace.');
  } else {
    logger.info('[Needle] No documents to re-embed.');
  }
  
  // Set server status back to ready when embedding is complete
  serverStatusEmitter.fire(ServerStatus.Ready);
}