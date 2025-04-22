// src/SearchSidebarViewProvider.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './utils/logger';
import { ServerStatus, currentServerStatus, onServerStatusChanged } from './embedding/server';

export class SearchSidebarViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    // Listen for server status changes
    this._disposables.push(
      onServerStatusChanged(status => {
        this.updateServerStatus(status);
      })
    );
  }

  private updateServerStatus(status: ServerStatus) {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'serverStatusUpdate',
        status
      });
    }
  }

  dispose() {
    // Clean up disposables
    this._disposables.forEach(d => d.dispose());
  }

  resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'src', 'searchSidebar'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media') // Keep media as fallback for now
      ]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async message => {
      if (message.type === 'debug') {
        logger.info('Generated HTML:', webviewView.webview.html);
      } else if (message.type === 'search') {
        const query = message.query;
        const exclusionPattern = message.exclusionPattern || '';
        logger.info(`[Needle] Received search request with query: "${query}" and exclusion pattern: "${exclusionPattern}"`);
        
        // Check if we have an API key first
        const apiKey = await vscode.commands.executeCommand('needle.getOpenAIKey');
        if (!apiKey) {
          this.postMessage({ 
            type: 'searchError', 
            message: 'OpenAI API Key is not set. Please set an API Key to use semantic search.'
          });
          return;
        }
        
        const results = await vscode.commands.executeCommand(
          'needle.performSearch', 
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
        logger.info(`[Needle] Regenerating embeddings with exclusion pattern: "${exclusionPattern}"`);
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Regenerating Needle embeddings...",
              cancellable: false
            },
            async () => {
              await vscode.commands.executeCommand('needle.regenerateEmbeddings', exclusionPattern);
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
    // Get file paths and log them to help debug
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'searchSidebar', 'sidebar.html');
    const cssPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'searchSidebar', 'sidebar.css');
    
    logger.info('Loading HTML from:', htmlPath.fsPath);
    logger.info('Loading CSS from:', cssPath.fsPath);
    
    // Convert to webview URIs
    const cssUri = webview.asWebviewUri(cssPath);
    
    // Read HTML file content
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    
    // Replace the CSS URI placeholder
    html = html.replace(/\${cssUri}/g, cssUri.toString());
    
    // Replace webview.cspSource placeholder
    html = html.replace(/\${webview\.cspSource}/g, webview.cspSource);
    
    // Generate and replace nonce
    const nonce = this.getNonce();
    html = html.replace(/\${nonce}/g, nonce);
    
    return html;
  }
  
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
