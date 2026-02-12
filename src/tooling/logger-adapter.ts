import type { Logger } from '../core/logger.js';
import type { DebugLogger } from './proxy-executor.js';

export class LoggerAdapter implements Logger {
  constructor(private delegate: DebugLogger) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this.delegate.debug(message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.delegate.debug(message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (this.delegate.warn) {
      this.delegate.warn(message, context);
    } else {
      this.delegate.debug(message, context);
    }
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    const ctx = error ? { ...context, error: error.message } : context;
    if (this.delegate.warn) {
      this.delegate.warn(message, ctx);
    } else {
      this.delegate.debug(message, ctx);
    }
  }
}
