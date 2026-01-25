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

const WELL_KNOWN_SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'client_assertion',
  'code',
  'code_verifier',
]);

function deepRedactWellKnownSecrets(value: unknown, depth: number = 0, seen?: WeakSet<object>): unknown {
  if (depth > 20) return value;
  if (value === null || typeof value !== 'object') return value;

  if (!seen) seen = new WeakSet();
  if (seen.has(value as object)) return value;
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map(item => deepRedactWellKnownSecrets(item, depth + 1, seen));
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(record)) {
    if (WELL_KNOWN_SECRET_KEYS.has(key)) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = deepRedactWellKnownSecrets(val, depth + 1, seen);
  }
  return out;
}

function resolveLogLevel(explicitLevel?: LogLevel): LogLevel {
  if (explicitLevel !== undefined) return explicitLevel;

  const envLevel = process.env.MCP4_LOG_LEVEL?.toUpperCase();
  return envLevel && envLevel in LogLevel
    ? LogLevel[envLevel as keyof typeof LogLevel]
    : LogLevel.INFO;
}

/**
 * Sanitize log message to prevent log injection
 * Replaces newlines with escaped string representation
 */
export function sanitizeLogMessage(message: string): string {
  return message.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function redactSensitiveContext(
  data: Record<string, unknown>,
  authConfig?: AuthInterceptor
): Record<string, unknown> {
  const redacted = deepRedactWellKnownSecrets(data) as Record<string, unknown>;
  if (!authConfig) return redacted;

  switch (authConfig.type) {
    case 'bearer':
      redacted.headers = redactHeader(redacted.headers, 'authorization');
      break;

    case 'custom-header':
      if (authConfig.header_name) {
        redacted.headers = redactHeader(
          redacted.headers,
          authConfig.header_name.toLowerCase()
        );
      }
      break;

    case 'query':
      if (authConfig.query_param) {
        redacted.url = redactQueryParam(
          redacted.url as string | undefined,
          authConfig.query_param
        );
        redacted.params = redactParam(
          redacted.params,
          authConfig.query_param
        );
      }
      break;
  }

  return redacted;
}

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
    this.level = resolveLogLevel(level);
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
    const redacted = context ? redactSensitiveContext(context, this.authConfig) : undefined;
    const ctx = redacted ? ` ${JSON.stringify(redacted)}` : '';
    const safeMessage = sanitizeLogMessage(message);
    console.error(`[${timestamp}] ${level}: ${safeMessage}${ctx}`);
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
    this.level = resolveLogLevel(level);
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
    const redacted = context ? redactSensitiveContext(context, this.authConfig) : undefined;
    const log = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...redacted,
    };
    console.error(JSON.stringify(log));
  }
}
