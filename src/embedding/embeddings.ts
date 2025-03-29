// src/embedding/embeddings.ts
import { global } from '../extension';
import { startEmbeddingServer } from './server';

// Server configuration
const SERVER_PORT = 8000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// Flag to track server status
let serverReady = false;


/**
 * Gets an embedding from the local embedding server
 */
export async function getLocalEmbedding(text: string): Promise<number[] | null> {
  if (!serverReady) {
    const started = await startEmbeddingServer(global.extensionContext);
    if (!started) {
      console.error('[Search++] Failed to start embedding server');
      return null;
    }
    serverReady = true;
  }
  
  try {
    console.log(`[Search++] Sending embedding request to local server for text (length: ${text.length})`);
    const res = await fetch(`${SERVER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: text })
    });
    
    const data = await res.json() as any;
    console.log('[Search++] Received embedding response from local server');
    return data?.embedding || null;
  } catch (err) {
    console.error('[Search++] Local embedding error:', err);
    return null;
  }
}

/**
 * Gets an embedding for text - uses local embedding server
 * (apiKey parameter is kept for backward compatibility)
 */
export async function getEmbedding(text: string, apiKey?: string): Promise<number[] | null> {
  // Switch to local embedding - apiKey parameter is ignored
  return getLocalEmbedding(text);
}

/**
 * Setter for server status
 */
export function setServerReady(status: boolean): void {
  serverReady = status;
}

/**
 * Getter for server status
 */
export function isServerReady(): boolean {
  return serverReady;
}