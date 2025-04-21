# Embedding Improvements Plan for Needle

This document outlines a comprehensive plan for improving the embedding system in Needle to enhance semantic search capabilities.

## Current Implementation Overview

Currently, Needle uses:
- OpenAI's `text-embedding-3-small` model
- ChromaDB for vector storage
- Document symbolization via VS Code's DocumentSymbol API
- Hierarchical context (Class > method) for semantic enrichment
- SHA-256 fingerprinting to avoid re-embedding unchanged code

## 1. Contextual Enrichment

### Short-term Improvements (1-2 weeks)

- **LSP-based Context Extraction**
  - Use LSP's `DocumentSymbol` API to extract hierarchical context (e.g., class > method > block).
  - Extract comments and docstrings near symbols using LSP-provided ranges.
  - Include type annotations, parameter names, and return types from LSP's `Hover` or `SignatureHelp` APIs.
  - Add file-level metadata (e.g., file paths, module names).

- **Cross-file Relationships**
  - Use LSP's `References` API to track function calls and inheritance.
  - Include caller/callee relationships and dependency graphs.

- **Intelligent Context Selection**
  - Focus on relevant symbols and their immediate parents/children.
  - Skip unrelated symbols or overly verbose comments to avoid washing out the subject.

### Medium-term Improvements (1-2 months)

- **Framework-specific Enhancements**
  - Use LSP to extract React component props, hooks, and Angular service relationships.
  - Extract backend API route handlers and middleware relationships.

- **Metadata Enrichment**
  - Add symbol-specific metadata like visibility (public/private), inheritance, and annotations.
  - Include language-specific metadata (e.g., package.json for Node.js).

## 2. Chunking Strategy Improvements

### Short-term Improvements

- **Semantic Chunking**
  - Use LSP to identify logical boundaries (e.g., functions, classes) for chunking.
  - Implement a sliding window with overlap to ensure no context is lost between chunks.

- **Token-aware Processing**
  - Add precise token counting for embedding models.
  - Balance chunk size with meaningful boundaries.

### Medium-term Improvements

- **Hierarchical Chunking**
  - Generate embeddings at multiple granularities (file, class, method, block).
  - Enable multi-level search (find relevant files, then drill down).
  - Implement parent-child relationships in vector store.

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
//   "needle.embedding.provider": "openai",
//   "needle.embedding.model": "text-embedding-3-small",
//   "needle.embedding.dimensions": 1536
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

1. Enhance `getSymbolContextWithParents` to use LSP for hierarchical context extraction.
2. Add type information extraction using LSP's `Hover` or `SignatureHelp` APIs.
3. Use LSP's `References` API to include cross-file relationships.
4. Add tests for LSP-based context extraction.

### Phase 2: Chunking Improvements (Weeks 3-4)

1. Implement token-aware chunking with LSP-based boundaries.
2. Add sliding window with overlap for chunking.
3. Refactor indexing to support hierarchical embeddings.
4. Optimize embedding batch sizes.

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