# Needle

Needle is an AI-powered Visual Studio Code extension that helps you find the proverbial "needle in a haystack" within your codebase. With Needle, developers can search their code using queries like "Where do we validate user inputs?" and quickly uncover relevant, ranked results.

## Features

- **Semantic Search**: Use natural language to search your codebase.
- **Advanced Filtering**: Exclude files or directories using regex patterns.
- **Context-Aware Results**: Results are ranked based on semantic relevance and user context.
- **Embeddings**: Uses AI embeddings to understand code structure and relationships.
- **Customizable**: Configure settings like embedding models, exclusion patterns, and more.

## Installation

1. Download and install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/).
2. Open your project in Visual Studio Code.
3. Activate Needle from the Activity Bar or Command Palette.

## Usage

1. Open the Needle sidebar from the Activity Bar.
2. Enter your query in the search box (e.g., "Find all API route handlers").
3. View and interact with the ranked results.
4. Use the "Regenerate Index" button to update embeddings after significant code changes.

## Commands

- `Needle: Smart Find` - Perform a semantic search.
- `Needle: Regenerate Embeddings` - Rebuild the embeddings cache for your workspace.

## Configuration

Needle offers several configuration options via `settings.json`:

```json
{
  "Needle.embedding.provider": "openai",
  "Needle.embedding.model": "text-embedding-3-small",
  "Needle.exclusionPatterns": ["*.json", "*.md"]
}
```

## Development

### Prerequisites

- Node.js
- npm
- Python (for the embedding server)

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

### Testing

Run tests using the following command:
```bash
npm test
```

## Contributing

Contributions are welcome! Please read the [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.