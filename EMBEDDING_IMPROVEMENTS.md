# Embedding Improvements Plan for Search++

This document outlines a comprehensive plan for improving the embedding system in Search++ to enhance semantic search capabilities.

## Current Implementation Overview

Currently, Search++ uses:
- OpenAI's `text-embedding-3-small` model
- ChromaDB for vector storage
- Document symbolization via VS Code's DocumentSymbol API
- Hierarchical context (Class > method) for semantic enrichment
- SHA-256 fingerprinting to avoid re-embedding unchanged code

## 1. Contextual Enrichment

### Short-term Improvements (1-2 weeks)

- **Comment Integration**
  - Extract docstrings and comments above functions/classes
  - Include JSDoc/TSDoc parameters and return type descriptions
  - Add file-level comments and license information

```typescript
// Example implementation for comment extraction
function getDocComments(symbol: vscode.DocumentSymbol, doc: vscode.TextDocument): string {
  const startLine = Math.max(0, symbol.range.start.line - 10);
  const commentLines = [];
  
  for (let i = startLine; i < symbol.range.start.line; i++) {
    const line = doc.lineAt(i).text.trim();
    if (line.startsWith('/*') || line.startsWith('*') || 
        line.startsWith('//') || line.startsWith('#')) {
      commentLines.push(line);
    } else if (commentLines.length > 0 && line === '') {
      // Keep empty lines between comments
      commentLines.push('');
    } else if (commentLines.length > 0) {
      // Stop when we hit non-comment, non-empty lines after comments
      break;
    }
  }
  
  return commentLines.join('\n');
}
```

- **Semantic Code Structure**
  - Include function parameters and types in context
  - Add information about imports and dependencies
  - Extract class inheritance and interface implementation

### Medium-term Improvements (1-2 months)

- **Cross-reference Integration**
  - Track function calls between files
  - Include caller/callee relationships
  - Add dependency graphs for functions/classes

- **Framework-specific Context**
  - Specialized handling for React components (props, hooks)
  - Angular service/component relationships
  - Backend API routes and handlers

## 2. Chunking Strategy Improvements

### Short-term Improvements

- **Intelligent Chunking**
  - Split large files into semantic units rather than arbitrary chunks
  - Ensure each chunk maintains sufficient context
  - Balance chunk size with meaningful boundaries

```typescript
// Example implementation for improved chunking
function tokenAwareChunking(code: string, maxTokens: number = 512): string[] {
  // Approximate tokens (very rough estimate for prototyping)
  const estimatedTokens = code.length / 4;
  
  if (estimatedTokens <= maxTokens) {
    return [code];
  }
  
  // Find logical boundaries (functions, blocks)
  const chunks = [];
  const lines = code.split('\n');
  let currentChunk = [];
  let currentTokens = 0;
  
  for (const line of lines) {
    const lineTokens = line.length / 4;
    
    if (currentTokens + lineTokens > maxTokens && currentChunk.length > 0) {
      // Finish current chunk if adding this line would exceed max tokens
      chunks.push(currentChunk.join('\n'));
      currentChunk = [];
      currentTokens = 0;
    }
    
    currentChunk.push(line);
    currentTokens += lineTokens;
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join('\n'));
  }
  
  return chunks;
}
```

### Medium-term Improvements

- **Token-aware Processing**
  - Add precise token counting for embedding models
  - Implement sliding window with overlap for contexts
  - Ensure optimal token utilization for embedding models

- **Hierarchical Chunking**
  - Generate embeddings at multiple granularities (file, class, method, block)
  - Enable multi-level search (find relevant files, then drill down)
  - Implement parent-child relationships in vector store

## 3. Embedding Provider Enhancements

### Short-term Improvements

- **Model Options**
  - Add support for multiple embedding models
  - Configurable model selection in settings
  - Support for local models through custom endpoints

```typescript
// Example configuration interface
interface EmbeddingConfig {
  provider: 'openai' | 'local' | 'custom';
  model: string;
  dimensions: number;
  endpoint?: string;
  apiKey?: string;
}

// Example settings.json contribution
// {
//   "searchpp.embedding.provider": "openai",
//   "searchpp.embedding.model": "text-embedding-3-small",
//   "searchpp.embedding.dimensions": 1536
// }
```

### Medium-term Improvements

- **Local Model Support**
  - Add built-in support for Hugging Face models
  - Implement model download and caching
  - Optimize for different hardware capabilities

- **Hybrid Embedding Strategies**
  - Combine lexical search with semantic search
  - Implement dual embedding for code and natural language
  - Add prefix boosting for specific file types/paths

## 4. Vector Storage Optimizations

### Short-term Improvements

- **ChromaDB Optimizations**
  - Add metadata filtering for searches
  - Implement incremental updates
  - Optimize collection management

```python
# Example improved ChromaDB usage in Python
def search_with_metadata(query, filters=None):
    return collection.query(
        query_texts=[query],
        n_results=15,
        where=filters or {}  # Add metadata filtering
    )
```

### Medium-term Improvements

- **Alternative Storage Options**
  - Add support for SQLite + pgvector
  - Implement Qdrant or other dedicated vector DBs
  - Create abstraction layer for storage backends

## 5. Implementation Plan

### Phase 1: Contextual Enrichment (Weeks 1-2)

1. Enhance `getSymbolContextWithParents` to include comments
2. Add type information extraction to context
3. Improve language-specific context handling
4. Add tests for context extraction

### Phase 2: Chunking Improvements (Weeks 3-4)

1. Implement token counting utilities
2. Add intelligent chunk boundary detection
3. Refactor indexing to support overlapping chunks
4. Optimize embedding batch sizes

### Phase 3: Multiple Model Support (Weeks 5-6)

1. Create embedding provider abstraction layer
2. Add settings for model configuration
3. Implement local model support in Python server
4. Add model performance benchmarking

### Phase 4: Storage Optimizations (Weeks 7-8)

1. Enhance ChromaDB integration with filtering
2. Implement incremental updates for changed files
3. Add storage statistics and diagnostics
4. Create backup/restore functionality for embeddings

## 6. Measurement Metrics

To evaluate the effectiveness of these improvements:

- **Search Quality**: Compare search results before/after improvements
- **Performance**: Measure indexing speed and search latency
- **Memory Usage**: Monitor memory consumption during indexing
- **API Usage**: Track embedding API call frequency and token usage
- **User Satisfaction**: Add feedback mechanism in the UI