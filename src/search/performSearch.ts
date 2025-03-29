// src/search/performSearch.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLocalEmbedding } from '../embedding/embeddings';
import { EmbeddedChunk, cosineSimilarity } from '../utils/embeddingUtils';
import { indexWorkspace } from '../embedding/indexer';
import { startEmbeddingServer } from '../embedding/server';
import { global } from '../extension';

const EMBEDDING_FILE = 'searchpp.embeddings.json';
const SIMILARITY_THRESHOLD = 0.2; // Only consider results with a score above this threshold
const MAX_RESULTS = 15; // Maximum number of results to return

/**
 * Determines if a code chunk is minified based on its density.
 * @param code The code chunk to evaluate.
 * @returns True if the code is minified, false otherwise.
 */
function isMinifiedCode(code: string): boolean {
  const lines = code.split('\n').length;
  const nonWhitespaceChars = code.replace(/\s/g, '').length;
  const density = nonWhitespaceChars / lines;
  return density > 300; // Adjust threshold as needed
}

/**
 * Performs semantic search based on a query and returns matching code chunks
 */
export async function performSearch(query: string): Promise<EmbeddedChunk[]> {
  if (!query) {
    return [];
  }

  // Ensure the server is ready
  const serverStarted = await startEmbeddingServer(global.extensionContext);
  if (!serverStarted) {
    vscode.window.showErrorMessage('Search++: Failed to start embedding server. Please try again.');
    return [];
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    vscode.window.showErrorMessage('Search++: No workspace folder open.');
    return [];
  }
  const workspacePath = workspaceFolders[0].uri.fsPath;
  const embeddingPath = path.join(workspacePath, EMBEDDING_FILE);

  let embeddedChunks: EmbeddedChunk[] = [];
  if (fs.existsSync(embeddingPath)) {
    console.log(`[Search++] Loading embeddings from ${embeddingPath}`);
    const raw = fs.readFileSync(embeddingPath, 'utf-8');
    embeddedChunks = JSON.parse(raw);
  } else {
    console.log('[Search++] Embedding file not found. Starting full indexing...');
    // Pass empty string instead of API key since we don't need it anymore
    embeddedChunks = await indexWorkspace("");
    fs.writeFileSync(embeddingPath, JSON.stringify(embeddedChunks, null, 2), 'utf-8');
    console.log(`[Search++] Indexed and stored ${embeddedChunks.length} code chunks.`);
  }

  console.log('[Search++] Embedding user query...');
  const queryEmbedding = await getLocalEmbedding(query);
  if (!queryEmbedding) {
    vscode.window.showErrorMessage('Search++: Failed to embed query.');
    return [];
  }

  console.log('[Search++] Scoring matches...');
  const results = embeddedChunks.map(chunk => {
    return {
      ...chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    };
  }).filter(result => result.score >= SIMILARITY_THRESHOLD) // Filter out low-quality matches
    .filter(result => !isMinifiedCode(result.code)) // Exclude minified code
    .sort((a, b) => b.score - a.score);

  // Limit results to those within 0.05 of the top result's score
  const topScore = results.length > 0 ? results[0].score : 0;
  const filteredResults = results.filter(result => result.score >= topScore - 0.08);

  // Deduplicate results based on code content and file path
  const deduplicatedResults = [];
  const seenFingerprints = new Set<string>();

  for (const result of filteredResults) {
    const compositeKey = `${result.filePath}:${result.fingerprint}`;
    if (!seenFingerprints.has(compositeKey)) {
      seenFingerprints.add(compositeKey);
      deduplicatedResults.push(result);

      if (deduplicatedResults.length >= MAX_RESULTS) {
        break;
      }
    }
  }

  console.log(`[Search++] Top matches: ${deduplicatedResults.length}`);
  return deduplicatedResults;
}