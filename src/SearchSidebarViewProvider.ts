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
        const results = await vscode.commands.executeCommand('searchpp.performSearch', query);
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
        </style>
      </head>
      <body>
        <div class="search-container">
          <div class="heading">Search your codebase semantically</div>
          <form id="searchForm">
            <input id="queryInput" type="text" placeholder="Ask your code..." />
            <button id="searchButton" type="submit">Search</button>
          </form>
        </div>
        
        <div id="loadingIndicator" class="loading" style="display: none;">
          Searching code...
        </div>
        
        <div id="resultsContainer"></div>

        <script>
          const vscode = acquireVsCodeApi();
          const resultsContainer = document.getElementById('resultsContainer');
          const loadingIndicator = document.getElementById('loadingIndicator');
          
          document.getElementById('searchForm').addEventListener('submit', (e) => {
            e.preventDefault();
            search();
          });
          
          function search() {
            const query = document.getElementById('queryInput').value;
            if (query.trim() !== '') {
              loadingIndicator.style.display = 'block';
              resultsContainer.innerHTML = '';
              vscode.postMessage({ type: 'search', query });
            }
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
                <div class="result-path">\${result.filePath}</div>
                <div class="result-preview">\${highlightCode(result.code)}</div>
              \`;
              
              resultsContainer.appendChild(resultItem);
            });
          }
          
          function highlightCode(code) {
            // Simple syntax highlighting
            // In a real implementation, you might want to use a library or more sophisticated approach
            const escapedCode = escapeHtml(code);
            
            // Truncate if too long
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