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
  try {
    const response = await fetch('http://localhost:8000/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: [text] }) // 🔥 wrap input as batch
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Search++] Embedding error: ${response.status} - ${errorText}`);
      return null;
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings[0]; // 🔥 return the first embedding from the array
  } catch (err) {
    console.error('[Search++] Failed to embed query:', err);
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