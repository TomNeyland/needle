// src/SearchSidebarViewProvider.ts
import * as vscode from 'vscode';

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
        vscode.commands.executeCommand('searchpp.smartFind', query);
      }
    });
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
            margin-top: 10px; 
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
          }
          .heading {
            font-size: 14px;
            margin-bottom: 10px;
          }
        </style>
      </head>
      <body>
        <div class="search-container">
          <div class="heading">Search your codebase semantically</div>
          <input id="queryInput" type="text" placeholder="Ask your code..." />
          <button id="searchButton">Search</button>
        </div>

        <script>
          const vscode = acquireVsCodeApi();
          
          document.getElementById('searchButton').addEventListener('click', () => {
            search();
          });
          
          document.getElementById('queryInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              search();
            }
          });
          
          function search() {
            const query = document.getElementById('queryInput').value;
            if (query.trim() !== '') {
              vscode.postMessage({ type: 'search', query });
            }
          }
        </script>
      </body>
      </html>
    `;
  }
}