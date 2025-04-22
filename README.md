# <img src="media/icon.png" alt="Needle Logo" height="30" style="vertical-align: middle;"> Needle 

Needle is an AI-powered Visual Studio Code extension that helps you find the proverbial "needle in a haystack" within your codebase. With Needle, developers can search their code using queries like "Where do we validate user inputs?" and quickly uncover relevant, ranked results.

## Features

- **Semantic Search**: Use natural language to search your codebase.
- **Content-Aware Results**: Search results understand code context including classes, methods, and hierarchies.
- **Intelligent Filtering**: Include or exclude files using glob patterns to narrow your search.
- **Real-time Indexing**: Auto-indexes your workspace and updates embeddings when files change.
- **Seamless Code Navigation**: Click on search results to jump directly to relevant code.

## Requirements

- Visual Studio Code 1.98.0 or higher
- Python 3.6+
- **An OpenAI API key** (for embedding generation)

## Installation

1. Install the extension from the VS Code Marketplace.
2. Open your project in VS Code.
3. Click on the Needle icon in the Activity Bar.
4. Enter your OpenAI API key when prompted.

## Usage

1. Click the Needle icon in the Activity Bar to open the search sidebar.
2. Type a natural language query in the search box (e.g., "How is authentication implemented?").
3. Optionally, provide include/exclude patterns to filter by file types or paths.
4. Press Enter or click Search to perform the search.
5. Click on any search result to open the corresponding file at the relevant location.

## Commands

The extension provides the following commands:

- `Needle: Smart Find` - Launch the semantic search interface (Ctrl+Shift+P, then type "Needle: Smart Find")
- `Needle: Set OpenAI API Key` - Configure your OpenAI API key
- `Needle: Clear OpenAI API Key` - Remove your stored API key
- `Needle: Regenerate Embeddings Cache` - Force a re-indexing of your workspace

## Configuration

Currently, Needle supports the following configuration in your VS Code settings, typically you configure this through the UI prompts though:

```json
{
  "needle.openaiApiKey": "your-api-key-here"
}
```

The API key can also be provided through the `NEEDLE_OPENAI_API_KEY` environment variable.

## How It Works

Needle uses AI embeddings to understand your code semantically:

1. It indexes your workspace by analyzing code structure using VS Code's DocumentSymbol API
2. Each code chunk is embedded using OpenAI's text-embedding-3-small model
3. Embeddings are stored in a local ChromaDB vector database
4. When you search, your query is embedded and matched against the code embeddings
5. Results are ranked by semantic similarity to your query

## Development

### Prerequisites

- Node.js 16+
- npm
- Python 3.6+

### Setup

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run watch
   ```
4. Press F5 to launch the extension in a new VS Code window.

### Python Dependencies

The extension uses the following Python packages:
- fastapi
- uvicorn
- openai
- chromadb

These will be automatically installed in a virtual environment when the extension is first run.

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.