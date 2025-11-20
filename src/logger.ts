/**
 * Logger interfaces and implementations
 * 
 * Why: Replaces console.error with structured, level-based logging.
 * Enables production-ready logging with context and proper error handling.
 * 
 * Security: Profile-aware token redaction prevents sensitive data leakage.
 */

import type { AuthInterceptor } from './types/profile.js';

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
        // Redact standard Authorization header
        redacted.headers = this.redactHeader(redacted.headers, 'authorization');
        break;
        
      case 'custom-header':
        // Redact custom header (e.g., X-API-Key)
        if (this.authConfig.header_name) {
          redacted.headers = this.redactHeader(
            redacted.headers,
            this.authConfig.header_name.toLowerCase()
          );
        }
        break;
        
      case 'query':
        // Redact query parameter (e.g., ?api_key=secret)
        if (this.authConfig.query_param) {
          redacted.url = this.redactQueryParam(
            redacted.url as string | undefined,
            this.authConfig.query_param
          );
          redacted.params = this.redactParam(
            redacted.params,
            this.authConfig.query_param
          );
        }
        break;
    }
    
    return redacted;
  }

  /**
   * Redact specific header (case-insensitive)
   */
  private redactHeader(
    headers: unknown,
    headerName: string
  ): Record<string, unknown> {
    if (!headers || typeof headers !== 'object') return {};
    
    const redacted = { ...(headers as Record<string, unknown>) };
    
    // Case-insensitive header matching
    for (const key of Object.keys(redacted)) {
      if (key.toLowerCase() === headerName.toLowerCase()) {
        redacted[key] = '[REDACTED]';
      }
    }
    
    return redacted;
  }

  /**
   * Redact query parameter from URL string
   */
  private redactQueryParam(
    url: string | undefined,
    paramName: string
  ): string {
    if (!url) return '';
    
    try {
      const urlObj = new URL(url);
      if (urlObj.searchParams.has(paramName)) {
        urlObj.searchParams.set(paramName, '[REDACTED]');
      }
      return urlObj.toString();
    } catch {
      // Fallback: simple string replace for relative URLs
      const regex = new RegExp(`([?&]${paramName}=)[^&]+`, 'gi');
      return url.replace(regex, `$1[REDACTED]`);
    }
  }

  /**
   * Redact parameter from params object
   */
  private redactParam(
    params: unknown,
    paramName: string
  ): Record<string, unknown> {
    if (!params || typeof params !== 'object') return {};
    
    const redacted = { ...(params as Record<string, unknown>) };
    if (paramName in redacted) {
      redacted[paramName] = '[REDACTED]';
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
        redacted.headers = this.redactHeader(redacted.headers, 'authorization');
        break;
        
      case 'custom-header':
        if (this.authConfig.header_name) {
          redacted.headers = this.redactHeader(
            redacted.headers,
            this.authConfig.header_name.toLowerCase()
          );
        }
        break;
        
      case 'query':
        if (this.authConfig.query_param) {
          redacted.url = this.redactQueryParam(
            redacted.url as string | undefined,
            this.authConfig.query_param
          );
          redacted.params = this.redactParam(
            redacted.params,
            this.authConfig.query_param
          );
        }
        break;
    }
    
    return redacted;
  }

  private redactHeader(
    headers: unknown,
    headerName: string
  ): Record<string, unknown> {
    if (!headers || typeof headers !== 'object') return {};
    
    const redacted = { ...(headers as Record<string, unknown>) };
    
    for (const key of Object.keys(redacted)) {
      if (key.toLowerCase() === headerName.toLowerCase()) {
        redacted[key] = '[REDACTED]';
      }
    }
    
    return redacted;
  }

  private redactQueryParam(
    url: string | undefined,
    paramName: string
  ): string {
    if (!url) return '';
    
    try {
      const urlObj = new URL(url);
      if (urlObj.searchParams.has(paramName)) {
        urlObj.searchParams.set(paramName, '[REDACTED]');
      }
      return urlObj.toString();
    } catch {
      const regex = new RegExp(`([?&]${paramName}=)[^&]+`, 'gi');
      return url.replace(regex, `$1[REDACTED]`);
    }
  }

  private redactParam(
    params: unknown,
    paramName: string
  ): Record<string, unknown> {
    if (!params || typeof params !== 'object') return {};
    
    const redacted = { ...(params as Record<string, unknown>) };
    if (paramName in redacted) {
      redacted[paramName] = '[REDACTED]';
    }
    
    return redacted;
  }
}

