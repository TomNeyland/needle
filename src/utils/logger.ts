import * as vscode from 'vscode';

/**
 * Log levels supported by the logger
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  LOG = 1,  // Same as INFO
  WARN = 2,
  ERROR = 3
}

/**
 * A production-ready logger for VS Code extensions that logs to an output channel
 */
export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;
  private logLevel: LogLevel = LogLevel.INFO;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel("Needle");
  }

  /**
   * Get the singleton instance of the logger
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Set the minimum log level to display
   */
  public setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Show the output channel
   */
  public show(): void {
    this.outputChannel.show();
  }

  /**
   * Log a debug message
   */
  public debug(...args: any[]): void {
    if (this.logLevel <= LogLevel.DEBUG) {
      this.log('[DEBUG]', ...args);
    }
  }

  /**
   * Log an info message
   */
  public info(...args: any[]): void {
    if (this.logLevel <= LogLevel.INFO) {
      this.log('[INFO]', ...args);
    }
  }

  /**
   * Log a standard message (same as info)
   */
  public log(...args: any[]): void {
    if (this.logLevel <= LogLevel.LOG) {
      const message = this.formatLogMessage(...args);
      this.outputChannel.appendLine(message);
    }
  }

  /**
   * Log a warning message
   */
  public warn(...args: any[]): void {
    if (this.logLevel <= LogLevel.WARN) {
      this.log('[WARN]', ...args);
    }
  }

  /**
   * Log an error message
   */
  public error(...args: any[]): void {
    if (this.logLevel <= LogLevel.ERROR) {
      this.log('[ERROR]', ...args);
    }
  }

  /**
   * Format log message arguments into a string
   */
  private formatLogMessage(...args: any[]): string {
    const timestamp = new Date().toISOString();
    const messages = args.map(arg => {
      if (typeof arg === 'string') {
        return arg;
      } else if (arg instanceof Error) {
        return arg.stack || arg.toString();
      } else {
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return arg.toString();
        }
      }
    });
    
    return `[${timestamp}] [Needle] ${messages.join(' ')}`;
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.outputChannel.dispose();
  }
}

// Export a default logger instance
export const logger = Logger.getInstance();
