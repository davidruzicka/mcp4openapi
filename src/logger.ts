/**
 * Logger interfaces and implementations
 * 
 * Why: Replaces console.error with structured, level-based logging.
 * Enables production-ready logging with context and proper error handling.
 * 
 * Security: Profile-aware token redaction prevents sensitive data leakage.
 */

import type { AuthInterceptor } from './types/profile.js';
import { escapeRegExp, redactHeader, redactQueryParam, redactParam } from './validation-utils.js';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: Error, context?: Record<string, unknown>): void;
}

/**
 * Default logger - writes to stderr, respects MCP4_LOG_LEVEL env var
 * 
 * Security: Redacts auth tokens based on profile configuration
 */
export class ConsoleLogger implements Logger {
  private level: LogLevel;
  private authConfig?: AuthInterceptor;

  constructor(level?: LogLevel, authConfig?: AuthInterceptor) {
    if (level !== undefined) {
      this.level = level;
    } else {
      // Parse from env
      const envLevel = process.env.MCP4_LOG_LEVEL?.toUpperCase();
      this.level = envLevel && envLevel in LogLevel
        ? LogLevel[envLevel as keyof typeof LogLevel]
        : LogLevel.INFO;
    }
    this.authConfig = authConfig;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      this.write('DEBUG', message, context);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      this.write('INFO', message, context);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) {
      this.write('WARN', message, context);
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.ERROR) {
      const errorContext = error ? {
        error: error.message,
        stack: error.stack,
        ...context,
      } : context;
      this.write('ERROR', message, errorContext);
    }
  }

  private write(level: string, message: string, context?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const redacted = context ? this.redactSensitive(context) : undefined;
    const ctx = redacted ? ` ${JSON.stringify(redacted)}` : '';
    console.error(`[${timestamp}] ${level}: ${message}${ctx}`);
  }

  /**
   * Redact sensitive data based on auth configuration
   * 
   * Why: Prevent token leakage in logs
   */
  private redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
    if (!this.authConfig) return data;
    
    const redacted = { ...data };
    
    switch (this.authConfig.type) {
      case 'bearer':
        redacted.headers = redactHeader(redacted.headers, 'authorization');
        break;
        
      case 'custom-header':
        if (this.authConfig.header_name) {
          redacted.headers = redactHeader(
            redacted.headers,
            this.authConfig.header_name.toLowerCase()
          );
        }
        break;
        
      case 'query':
        if (this.authConfig.query_param) {
          redacted.url = redactQueryParam(
            redacted.url as string | undefined,
            this.authConfig.query_param
          );
          redacted.params = redactParam(
            redacted.params,
            this.authConfig.query_param
          );
        }
        break;
    }
    
    return redacted;
  }
}

/**
 * Structured JSON logger for production
 * 
 * Why: Machine-readable logs for log aggregation systems (ELK, Splunk, etc.)
 * Security: Redacts auth tokens based on profile configuration
 */
export class JsonLogger implements Logger {
  private level: LogLevel;
  private authConfig?: AuthInterceptor;

  constructor(level?: LogLevel, authConfig?: AuthInterceptor) {
    if (level !== undefined) {
      this.level = level;
    } else {
      const envLevel = process.env.MCP4_LOG_LEVEL?.toUpperCase();
      this.level = envLevel && envLevel in LogLevel
        ? LogLevel[envLevel as keyof typeof LogLevel]
        : LogLevel.INFO;
    }
    this.authConfig = authConfig;
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.DEBUG) {
      this.write('debug', message, context);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.INFO) {
      this.write('info', message, context);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.WARN) {
      this.write('warn', message, context);
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    if (this.level <= LogLevel.ERROR) {
      this.write('error', message, {
        error: error?.message,
        stack: error?.stack,
        ...context,
      });
    }
  }

  private write(level: string, message: string, context?: Record<string, unknown>): void {
    const redacted = context ? this.redactSensitive(context) : undefined;
    const log = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...redacted,
    };
    console.error(JSON.stringify(log));
  }

  /**
   * Redact sensitive data based on auth configuration
   * 
   * Why: Prevent token leakage in logs (same logic as ConsoleLogger)
   */
  private redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
    if (!this.authConfig) return data;
    
    const redacted = { ...data };
    
    switch (this.authConfig.type) {
      case 'bearer':
        redacted.headers = redactHeader(redacted.headers, 'authorization');
        break;
        
      case 'custom-header':
        if (this.authConfig.header_name) {
          redacted.headers = redactHeader(
            redacted.headers,
            this.authConfig.header_name.toLowerCase()
          );
        }
        break;
        
      case 'query':
        if (this.authConfig.query_param) {
          redacted.url = redactQueryParam(
            redacted.url as string | undefined,
            this.authConfig.query_param
          );
          redacted.params = redactParam(
            redacted.params,
            this.authConfig.query_param
          );
        }
        break;
    }
    
    return redacted;
  }
}

