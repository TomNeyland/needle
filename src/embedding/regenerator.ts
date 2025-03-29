import * as vscode from 'vscode';
import { regenerateEmbeddings as performRegenerateEmbeddings } from '../search/performSearch';

export async function regenerateEmbeddings(exclusionPattern: string = ''): Promise<boolean> {
  try {
    console.log(`[Search++] Regenerating embeddings with exclusion pattern: "${exclusionPattern}"`);
    await performRegenerateEmbeddings(exclusionPattern);
    return true;
  } catch (error) {
    console.error('[Search++] Error regenerating embeddings:', error);
    throw error;
  }
}
