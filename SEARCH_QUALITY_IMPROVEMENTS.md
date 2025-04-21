# Search Quality Improvements for Needle

This document outlines strategies and improvements for enhancing search quality in the Needle extension.

## Current State Assessment

The current search implementation uses:
- OpenAI's embeddings API for semantic understanding
- Basic cosine similarity for result ranking
- Simple threshold filtering for relevance
- Limited user configuration for search parameters

## 1. Query Enhancement Techniques

### Query Understanding

- **Query Intent Classification**
  - Classify queries into categories (e.g., "find definition", "find usage", "understand concept")
  - Adjust search strategy based on detected intent
  - Example: "where is function X used" prioritizes caller references

- **Query Expansion**
  - Automatically expand queries with synonyms and related terms
  - Add programming language-specific terms
  - Example: Query "authentication check" expands to include "auth", "validation", "credentials", etc.

- **Query Preprocessing Pipeline**
  ```typescript
  interface QueryProcessor {
    process(query: string): Promise<string>;
  }
  
  class QueryPreprocessingPipeline {
    private processors: QueryProcessor[] = [];
    
    addProcessor(processor: QueryProcessor) {
      this.processors.push(processor);
    }
    
    async process(query: string): Promise<string> {
      let processedQuery = query;
      for (const processor of this.processors) {
        processedQuery = await processor.process(processedQuery);
      }
      return processedQuery;
    }
  }
  ```

### Query Templates

- **Structured Query Templates**
  - Create specialized templates for common search patterns
  - Example: "find-usage:functionName" to locate all usages of a specific function
  - Support for regex-like patterns within semantic search

## 2. Result Ranking Improvements

### Hybrid Ranking Approaches

- **Semantic + Lexical Hybrid**
  - Combine embedding similarity with text-based matching
  - Adjust weighting based on query characteristics
  - Better handling of specific symbol names vs. conceptual queries

- **Code-specific Signals**
  - Boost relevance for recently modified files
  - Consider symbol importance (exports, public methods)
  - Factor in symbol depth and relationship to entry points

- **Re-ranking with LLM**
  ```typescript
  async function llmReranking(query: string, results: EmbeddedChunk[], limit: number): Promise<EmbeddedChunk[]> {
    // Skip re-ranking if there are too few results
    if (results.length <= 3) return results;
    
    // Select top N results for re-ranking
    const topResults = results.slice(0, Math.min(10, results.length));
    
    // Create prompt for re-ranking
    const prompt = `Query: "${query}"
    
    Given the following code snippets, rank them based on relevance to the query.
    The most relevant snippet should perfectly answer or address the query.
    Return a comma-separated list of numbers indicating the ranking (most relevant first).
    
    ${topResults.map((r, i) => `[${i+1}] ${r.filePath}:
    ${r.code.substring(0, 300)}${r.code.length > 300 ? '...' : ''}`).join('\n\n')}`;
    
    try {
      // Use existing OpenAI client
      const ranking = await askLLM(prompt);
      
      // Parse ranking response (format: "3,1,4,2,5...")
      const newOrder = ranking.split(',').map(n => parseInt(n.trim()) - 1);
      
      // Reorder results based on LLM ranking
      const reranked = newOrder
        .filter(i => !isNaN(i) && i >= 0 && i < topResults.length)
        .map(i => topResults[i]);
      
      // Append any remaining results not included in the ranking
      const rerankedIds = new Set(reranked.map(r => r.fingerprint));
      const remaining = results.filter(r => !rerankedIds.has(r.fingerprint));
      
      return [...reranked, ...remaining].slice(0, limit);
    } catch (error) {
      console.error('[Needle] LLM re-ranking failed:', error);
      return results; // Fall back to original order
    }
  }
  ```

### Context-aware Ranking

- **User Context Integration**
  - Boost relevance for files the user recently worked with
  - Consider open editor tabs as higher relevance
  - Track successful searches to improve future rankings

- **Workspace Awareness**
  - Consider project structure and organization
  - Boost results in main source directories vs test/vendor code
  - Utilize .gitignore patterns for appropriate filtering

## 3. Filtering & Faceting

- **Advanced Filtering Options**
  - Filter by language, file path, or symbol type
  - Support for excluding certain paths or file types
  - Custom filtering rules in settings

- **Search Facets**
  - Provide aggregated counts of result types (functions, classes, etc.)
  - Allow filtering by symbol kind after search
  - Enable drill-down navigation of results

- **UI Implementation**
  ```html
  <div class="facets-container">
    <div class="facet-group">
      <h4>Symbol Types</h4>
      <div class="facet-options">
        <label><input type="checkbox" data-facet="kind:function" checked> Functions <span class="count">(23)</span></label>
        <label><input type="checkbox" data-facet="kind:class" checked> Classes <span class="count">(8)</span></label>
        <label><input type="checkbox" data-facet="kind:interface"> Interfaces <span class="count">(5)</span></label>
      </div>
    </div>
    
    <div class="facet-group">
      <h4>Languages</h4>
      <div class="facet-options">
        <label><input type="checkbox" data-facet="lang:typescript" checked> TypeScript <span class="count">(31)</span></label>
        <label><input type="checkbox" data-facet="lang:javascript" checked> JavaScript <span class="count">(12)</span></label>
        <label><input type="checkbox" data-facet="lang:python"> Python <span class="count">(7)</span></label>
      </div>
    </div>
  </div>
  ```

## 4. Relevance Feedback System

- **Explicit Feedback**
  - Add thumbs up/down buttons to search results
  - Use feedback to tune future search rankings
  - Build a personalized relevance model over time

- **Implicit Feedback**
  - Track which results the user clicked on
  - Monitor time spent viewing a result
  - Record whether user continued searching after viewing

- **Feedback Collection**
  ```typescript
  interface SearchFeedback {
    queryId: string;
    resultId: string;
    isRelevant: boolean;
    feedbackType: 'explicit' | 'implicit';
    timestamp: number;
  }
  
  class FeedbackStore {
    private feedbackItems: SearchFeedback[] = [];
    
    addFeedback(feedback: SearchFeedback) {
      this.feedbackItems.push(feedback);
      this.persistFeedback();
    }
    
    getFeedbackForQuery(queryId: string): SearchFeedback[] {
      return this.feedbackItems.filter(item => item.queryId === queryId);
    }
    
    private persistFeedback() {
      // Store feedback in extension context
      // Could be used for training or tuning ranking
    }
  }
  ```

## 5. Advanced Search Features

### Semantic Code Examples

- **Learning from Examples**
  - Allow users to select code and "find similar patterns"
  - Support "negative examples" to exclude unwanted patterns
  - Enable semantic code completion based on codebase patterns

- **Multi-modal Search**
  - Combine text queries with code examples
  - Example: "Find authentication logic similar to this example"
  - Weight different inputs in the final search

### Search Result Explanations

- **Relevance Explanations**
  - Explain why a result was included
  - Highlight key terms/concepts that matched the query
  - Show confidence scores for different aspects of the match

- **Result Summaries with LLM**
  - Generate concise explanations of what each result contains
  - Summarize how the code addresses the query intent
  - Extract key implementation details

## 6. Implementation Phases

### Phase 1: Query Enhancement (Weeks 1-2)

1. Implement basic query preprocessing
2. Add synonym expansion for common programming concepts
3. Create specialized query templates for common searches

### Phase 2: Ranking Improvements (Weeks 3-4)

1. Implement hybrid ranking combining semantic and lexical signals
2. Add basic context-aware boosting based on user activity
3. Prototype LLM re-ranking for high importance queries

### Phase 3: Filtering & UI (Weeks 5-6)

1. Add advanced filtering options in the search interface
2. Implement faceted search for result navigation
3. Create improved result visualization with better context

### Phase 4: Feedback & Learning (Weeks 7-8)

1. Add explicit feedback controls to search results
2. Implement implicit feedback tracking
3. Create system to apply feedback for ranking adjustments

## 7. Evaluation Metrics

- **Precision@K**: Relevance of top-K results
- **Mean Reciprocal Rank (MRR)**: Position of first relevant result
- **Time-to-success**: How quickly users find what they need
- **Search abandonment rate**: % of searches with no clicks
- **Feedback ratio**: % of positive vs negative feedback