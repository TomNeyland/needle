// src/search/performSearch.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddedChunk, parseHTMLSymbols, symbolIsTooSmall, generateFingerprint, getSymbolContextWithParents, extractCenteredCode, isMinifiedCode } from '../utils/embeddingUtils';
import { updateFileEmbeddings, FlattenedSymbol } from '../embedding/indexer';
import { startEmbeddingServer } from '../embedding/server';
import { global } from '../extension';

const SIMILARITY_THRESHOLD = 0.2; // Only consider results with a score above this threshold
const MAX_RESULTS = 30; // Maximum number of results to return
const MAX_CODE_CHUNK_SIZE = 1000; // Maximum characters allowed in a code chunk

/**
 * Checks if a file path should be excluded based on a regex pattern
 * @param filePath The file path to check
 * @param exclusionPattern The regex pattern to match against
 * @returns True if the file should be excluded, false otherwise
 */
function shouldExcludeFile(filePath: string, exclusionPattern: string): boolean {
  if (!exclusionPattern) return false;
  
  try {
    // Split by comma to support multiple patterns like "scss, py"
    const patterns = exclusionPattern.split(',').map(p => p.trim()).filter(p => p);
    
    for (const pattern of patterns) {
      // Convert glob patterns like *.{json,md} to proper regex
      let regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(',').join('|')})`)
        .trim();
      
      // If pattern is not a complete regex, wrap it to match anywhere in path
      if (!regexPattern.startsWith('^')) {
        regexPattern = `.*${regexPattern}`;
      }
      
      const regex = new RegExp(regexPattern, 'i');
      const isExcluded = regex.test(filePath);
      
      if (isExcluded) {
        console.log(`[Needle] Excluding file: ${filePath} (matched pattern: ${pattern})`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error(`[Needle] Invalid exclusion pattern: ${exclusionPattern}`, error);
    return false;
  }
}

/**
 * Performs semantic search based on a query and returns matching code chunks
 */
export async function performSearch(query: string, exclusionPattern?: string): Promise<EmbeddedChunk[]> {
  if (!query) {
    return [];
  }

  console.log(`[Needle] Performing search for query: "${query}"`);

  try {
    const res = await fetch('http://localhost:8000/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        max_results: MAX_RESULTS,
        similarity_threshold: SIMILARITY_THRESHOLD,
        exclusion_pattern: exclusionPattern || "" // Pass the exclusion pattern if provided
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`[Needle] Search API error ${res.status}: ${errorText}`);
      throw new Error(`[Needle] Failed to perform search: ${res.statusText}`);
    }

    const data = (await res.json()) as { results: EmbeddedChunk[] };
    const results: EmbeddedChunk[] = data.results;

    console.log(`[Needle] Found ${results.length} matching chunks.`);
    return results.slice(0, MAX_RESULTS); // Limit to max results
  } catch (err) {
    console.error(`[Needle] Error during search: ${err}`);
    return [];
  }
}