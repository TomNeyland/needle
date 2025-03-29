// src/SearchSidebarViewProvider.ts
import * as vscode from 'vscode';
import * as path from 'path';

export class SearchSidebarViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async message => {
      if (message.type === 'search') {
        const query = message.query;
        const exclusionPattern = message.exclusionPattern || '';
        console.log(`[Search++] Received search request with query: "${query}" and exclusion pattern: "${exclusionPattern}"`);
        
        // Make sure we're explicitly passing the exclusion pattern as a string
        const results = await vscode.commands.executeCommand(
          'searchpp.performSearch', 
          query, 
          exclusionPattern.toString()
        );
        this.postSearchResults(results as any);
      } else if (message.type === 'openFile') {
        const filePath = message.filePath;
        const lineStart = message.lineStart;
        const lineEnd = message.lineEnd;
        
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const range = new vscode.Range(lineStart, 0, lineEnd + 1, 0);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.end);
      } else if (message.type === 'regenerateEmbeddings') {
        const exclusionPattern = message.exclusionPattern || '';
        console.log(`[Search++] Regenerating embeddings with exclusion pattern: "${exclusionPattern}"`);
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Regenerating Search++ embeddings...",
              cancellable: false
            },
            async () => {
              await vscode.commands.executeCommand('searchpp.regenerateEmbeddings', exclusionPattern);
            }
          );
          this.postMessage({ type: 'regenerationSuccess' });
        } catch (error) {
          this.postMessage({ 
            type: 'regenerationError', 
            message: error instanceof Error ? error.message : 'An unknown error occurred'
          });
        }
      }
    });
  }

  public postSearchResults(results: any[]) {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'searchResults',
        results
      });
    }
  }

  private postMessage(message: any) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Search++</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            padding: 10px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
          }
          input[type="text"] {
            width: 100%;
            padding: 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
          }
          button {
            padding: 6px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            cursor: pointer;
          }
          button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }
          .search-container {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-bottom: 15px;
          }
          .heading {
            font-size: 14px;
            margin-bottom: 10px;
          }
          #resultsContainer {
            margin-top: 20px;
          }
          .result-item {
            padding: 8px;
            margin-bottom: 8px;
            border-radius: 4px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            cursor: pointer;
          }
          .result-item:hover {
            background-color: var(--vscode-list-hoverBackground);
          }
          .result-header {
            display: flex;
            justify-content: space-between;
            font-weight: bold;
            margin-bottom: 4px;
          }
          .result-path {
            font-size: 0.8em;
            opacity: 0.8;
            margin-bottom: 4px;
          }
          .result-score {
            font-size: 0.8em;
            opacity: 0.7;
          }
          .result-context {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
          }
          .result-preview {
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
            white-space: pre-wrap;
            overflow: hidden;
            max-height: 100px;
            padding: 4px;
            background-color: var(--vscode-editor-background);
            border-radius: 2px;
            margin-top: 4px;
          }
          .loading {
            text-align: center;
            margin: 20px 0;
            font-style: italic;
          }
          #searchForm {
            display: flex;
            gap: 8px;
          }
          #queryInput {
            flex-grow: 1;
          }
          .exclusion-container {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
            font-size: 12px;
          }
          .exclusion-container label {
            white-space: nowrap;
          }
          .exclusion-container input {
            flex-grow: 1;
            font-size: 12px;
            padding: 4px 6px;
          }
          .actions-container {
            display: flex;
            justify-content: flex-end;
            margin-top: 8px;
          }
          .regen-button {
            font-size: 12px;
            padding: 4px 8px;
          }
          .notification {
            margin-top: 10px;
            padding: 8px;
            border-radius: 4px;
            font-size: 12px;
          }
          .success {
            background-color: var(--vscode-terminal-ansiGreen);
            color: var(--vscode-editor-background);
          }
          .error {
            background-color: var(--vscode-terminal-ansiRed);
            color: var(--vscode-editor-foreground);
          }
        </style>
      </head>
      <body>
        <div class="search-container">
          <div class="heading">Search your codebase semantically</div>
          <form id="searchForm">
            <input id="queryInput" type="text" placeholder="Ask your code..." />
            <button id="searchButton" type="submit">Search</button>
          </form>
          
          <div class="exclusion-container">
            <label for="exclusionInput">Exclude:</label>
            <input id="exclusionInput" type="text" placeholder="e.g., *.{json,md,txt}" title="Regex pattern to exclude files from search" />
          </div>
          
          <div class="actions-container">
            <button id="regenerateButton" class="regen-button" title="Regenerate the embeddings cache file">Regenerate Index</button>
          </div>
          
          <div id="notification" class="notification" style="display: none;"></div>
        </div>
        
        <div id="loadingIndicator" class="loading" style="display: none;">
          Searching code...
        </div>
        
        <div id="resultsContainer"></div>

        <script>
          const vscode = acquireVsCodeApi();
          const resultsContainer = document.getElementById('resultsContainer');
          const loadingIndicator = document.getElementById('loadingIndicator');
          const notification = document.getElementById('notification');
          const exclusionInput = document.getElementById('exclusionInput');

          document.getElementById('searchForm').addEventListener('submit', (e) => {
            e.preventDefault();
            search();
          });
          
          document.getElementById('regenerateButton').addEventListener('click', (e) => {
            e.preventDefault();
            regenerateEmbeddings();
          });

          function search() {
            const query = document.getElementById('queryInput').value;
            const exclusionValue = document.getElementById('exclusionInput').value.trim();
            console.log('UI sending search with exclusion pattern:', exclusionValue);
            
            if (query.trim() !== '') {
              loadingIndicator.style.display = 'block';
              resultsContainer.innerHTML = '';
              vscode.postMessage({ 
                type: 'search', 
                query,
                exclusionPattern: exclusionValue
              });
            }
          }
          
          function regenerateEmbeddings() {
            const exclusionValue = document.getElementById('exclusionInput').value.trim();
            console.log('UI sending regenerate with exclusion pattern:', exclusionValue);
            
            notification.style.display = 'none';
            loadingIndicator.style.display = 'block';
            loadingIndicator.textContent = 'Regenerating embeddings cache...';
            vscode.postMessage({ 
              type: 'regenerateEmbeddings',
              exclusionPattern: exclusionValue
            });
          }

          function openFile(filePath, lineStart, lineEnd) {
            vscode.postMessage({
              type: 'openFile',
              filePath,
              lineStart,
              lineEnd
            });
          }

          window.addEventListener('message', event => {
            const message = event.data;

            if (message.type === 'searchResults') {
              loadingIndicator.style.display = 'none';
              displayResults(message.results);
            } else if (message.type === 'regenerationSuccess') {
              loadingIndicator.style.display = 'none';
              notification.textContent = 'Embeddings cache regenerated successfully.';
              notification.className = 'notification success';
              notification.style.display = 'block';
              setTimeout(() => {
                notification.style.display = 'none';
              }, 5000);
            } else if (message.type === 'regenerationError') {
              loadingIndicator.style.display = 'none';
              notification.textContent = 'Error: ' + message.message;
              notification.className = 'notification error';
              notification.style.display = 'block';
            }
          });

          function displayResults(results) {
            resultsContainer.innerHTML = '';

            if (results.length === 0) {
              resultsContainer.innerHTML = '<div class="no-results">No matching results found</div>';
              return;
            }

            results.forEach(result => {
              const resultItem = document.createElement('div');
              resultItem.className = 'result-item';
              resultItem.onclick = () => openFile(result.filePath, result.lineStart, result.lineEnd);

              const fileName = result.filePath.split('/').pop().split('\\\\').pop();

              resultItem.innerHTML = \`
                <div class="result-header">
                  <span>\${fileName}:\${result.lineStart + 1}</span>
                  <span class="result-score">\${result.score.toFixed(2)}</span>
                </div>
                <div class="result-path">\${escapeHtml(result.filePath)}</div>
                <div class="result-context">\${escapeHtml(result.context || '')}</div>
                <div class="result-preview">\${highlightCode(result.code)}</div>
              \`;

              resultsContainer.appendChild(resultItem);
            });
          }

          function highlightCode(code) {
            const escapedCode = escapeHtml(code);
            const maxLines = 7;
            const lines = escapedCode.split('\\n');
            let displayCode = lines.slice(0, maxLines).join('\\n');
            if (lines.length > maxLines) {
              displayCode += '\\n...';
            }
            return displayCode;
          }

          function escapeHtml(text) {
            return text
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
          }
        </script>
      </body>
      </html>
    `;
  }
}
