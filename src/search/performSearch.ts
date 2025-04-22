// src/search/performSearch.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddedChunk, parseHTMLSymbols, symbolIsTooSmall, generateFingerprint, getSymbolContextWithParents, extractCenteredCode, isMinifiedCode } from '../utils/embeddingUtils';
import { updateFileEmbeddings, FlattenedSymbol } from '../embedding/indexer';
import { startEmbeddingServer, SERVER_URL } from '../embedding/server';
import { global } from '../extension';
import { logger } from '../utils/logger';

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
        logger.info(`[Needle] Excluding file: ${filePath} (matched pattern: ${pattern})`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    logger.error(`[Needle] Invalid exclusion pattern: ${exclusionPattern}`, error);
    return false;
  }
}

/**
 * Checks if a file path should be included based on a regex pattern
 * @param filePath The file path to check
 * @param inclusionPattern The regex pattern to match against
 * @returns True if the file should be included, false if it doesn't match the inclusion pattern
 */
function shouldIncludeFile(filePath: string, inclusionPattern: string): boolean {
  if (!inclusionPattern) return true; // If no inclusion pattern, include all files
  
  try {
    // Split by comma to support multiple patterns like "ts, js"
    const patterns = inclusionPattern.split(',').map(p => p.trim()).filter(p => p);
    
    // If no valid patterns after filtering, include all files
    if (patterns.length === 0) return true;
    
    for (const pattern of patterns) {
      // Convert glob patterns like src/**/*.ts to proper regex
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
      const isIncluded = regex.test(filePath);
      
      if (isIncluded) {
        logger.info(`[Needle] Including file: ${filePath} (matched pattern: ${pattern})`);
        return true;
      }
    }
    
    // If no patterns matched, exclude the file
    logger.info(`[Needle] Skipping file: ${filePath} (didn't match any inclusion patterns)`);
    return false;
  } catch (error) {
    logger.error(`[Needle] Invalid inclusion pattern: ${inclusionPattern}`, error);
    return true; // On error, default to including files
  }
}

/**
 * Performs semantic search based on a query and returns matching code chunks
 */
export async function performSearch(query: string, exclusionPattern?: string, inclusionPattern?: string): Promise<EmbeddedChunk[]> {
  if (!query) {
    return [];
  }

  logger.info(`[Needle] Performing search for query: "${query}", inclusion pattern: "${inclusionPattern || ''}", exclusion pattern: "${exclusionPattern || ''}"`);

  try {
    const res = await fetch(`${SERVER_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        max_results: MAX_RESULTS,
        similarity_threshold: SIMILARITY_THRESHOLD,
        exclusion_pattern: exclusionPattern || "", // Pass the exclusion pattern if provided
        inclusion_pattern: inclusionPattern || ""  // Pass the inclusion pattern if provided
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      logger.error(`[Needle] Search API error ${res.status}: ${errorText}`);
      throw new Error(`[Needle] Failed to perform search: ${res.statusText}`);
    }

    const data = (await res.json()) as { results: EmbeddedChunk[] };
    const results: EmbeddedChunk[] = data.results;

    logger.info(`[Needle] Found ${results.length} matching chunks.`);
    return results.slice(0, MAX_RESULTS); // Limit to max results
  } catch (err) {
    logger.error(`[Needle] Error during search: ${err}`);
    return [];
  }
}