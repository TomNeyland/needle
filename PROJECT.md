🔍 Project Brief: Needle (Semantic Code Search for VS Code)

Needle is an AI-powered VS Code extension for semantic, natural-language codebase searching. It lets developers search their code using queries like "Where do we validate user inputs?" and quickly shows relevant, ranked results.
🚀 Current Status & Implementation Details

We're currently in the rapid prototyping stage, intentionally using simple solutions to iterate quickly:

    Embedding provider: OpenAI's text-embedding-3-small API

    Vector storage: A local JSON file (needle.embeddings.json) to keep embeddings persistently cached between sessions

    Chunking strategy: Using VS Code's built-in DocumentSymbol APIs to extract functions, classes, and methods, then prepending a hierarchical context (Class > method) to each chunk before embedding

    Fingerprinting: Implemented SHA-256 hashes to avoid unnecessary re-embedding on unchanged code chunks

    UI: A custom sidebar WebView with input box, search button, and clickable search results

🛠 Technical Decisions and Alternatives Previously Discussed

We carefully considered several technical options to help future-proof the design:
1. Embedding Providers (Current vs Future)

    Current (prototype):

        OpenAI API (text-embedding-3-small)

        Quick, reliable, easy to start with

    Alternatives considered (for future exploration):

        Local embedding models (e.g., Hugging Face’s all-MiniLM-L6-v2 for semantic embedding, OpenAI's open models like text-embedding-ada)

        Local hosting with models like Instructor

Why: Long-term goal is local/offline embedding capability to reduce costs and dependency.
2. Vector Store Options (Current vs Future)

    Current (prototype):

        Local JSON file (needle.embeddings.json)

        Simple, sufficient for prototyping, not optimal for scaling

    Alternatives considered (for future exploration):

        SQLite + pgvector for lightweight SQL-based semantic search

        ChromaDB for a simple local vector store

        Qdrant or Weaviate if we scale beyond a single user or workspace

Why: JSON works short-term but becomes slow/inflexible with large codebases. We’ll likely swap it out as the project grows.
🔜 Immediate Future Iterations Planned

1. Enhanced Chunk Context

    Already started embedding hierarchical context (Class > method).

    Next step: Include docstrings and comment blocks in embeddings for richer semantic context.

2. Smart Caching

    Already implemented fingerprint hashing (SHA-256) for embedding deduplication.

    Potential further optimizations:

        Partial re-embedding only of lines/symbols that have changed within larger blocks.

3. Configurable Settings

    Embedding model selection

    Parallel embedding request limits

    Max number of search results returned

🚧 Longer-Term Enhancements Considered

    Token-aware Chunking:

        Consider truncating or chunking code blocks to a maximum token length (~512-1024 tokens) to handle large symbols/functions.

    Semantic Re-ranking:

        Consider integrating an LLM (GPT-3.5, GPT-4, or local model) to re-rank the initial embedding results to significantly boost quality.

    Multiple Embedding Backends:

        Abstract out embedding logic to easily plug in different providers later.

    Advanced UI Improvements:

        Syntax highlighting in code previews (e.g., Shiki or Prism.js)

        Saved searches, query history, filtering by file paths/types

🎯 Core Design Principles (Keep These In Mind)

    Context first: Rich embeddings via thoughtful chunking/context.

    Incremental updates: Embed once, reuse extensively.

    Efficient: Avoid unnecessary computation and API calls.

    Fast: Keep indexing and querying quick and responsive.

    Modular: Design for easy swapping of components in the future.

🚨 Immediate Next Steps (For New Chat Instance)

Here's what you should do right after receiving this brief:

    Review and ingest the current codebase (pasted separately by the user).

    Continue the current iteration by:

        Improving the embedding context (add docstrings/comments next).

        Surfacing some of these configurations (settings.json) next.

    Keep in mind the explored technical options listed above, so you don't rediscover the same solutions.

📌 TL;DR for the New Chat Instance

You’re co-building Needle, a semantic VS Code extension prototype currently using OpenAI embeddings + JSON storage. You're aware of previously considered alternatives (local embeddings, ChromaDB, SQLite+pgvector). You’ll soon enhance chunk context with comments, implement token-aware chunking, and add semantic reranking.

Your immediate goals:

    Enhance embedding context further (comments/docstrings).

    Expose settings via VS Code’s native config mechanisms.

Build thoughtfully, leveraging previous research to move quickly and confidently.