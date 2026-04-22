/**
 * Typed errors for upstream MCP connections
 *
 * Each error class includes a correlation ID for tracing and passes
 * all messages through sanitization to prevent credential leakage.
 */

import { MCPError, generateCorrelationId } from '../core/errors.js';
import { sanitizeAuthErrorMessage } from '../auth/auth-redaction.js';

export class UpstreamConnectionError extends MCPError {
  constructor(message: string, providerName: string) {
    const correlationId = generateCorrelationId();
    super(
      sanitizeAuthErrorMessage(message),
      'UPSTREAM_CONNECTION_ERROR',
      { correlationId, providerName },
    );
    this.name = 'UpstreamConnectionError';
  }
}

export class UpstreamTimeoutError extends MCPError {
  constructor(providerName: string, timeoutMs: number) {
    const correlationId = generateCorrelationId();
    super(
      sanitizeAuthErrorMessage(
        `Upstream provider '${providerName}' timed out after ${timeoutMs}ms`,
      ),
      'UPSTREAM_TIMEOUT',
      { correlationId, providerName, timeoutMs },
    );
    this.name = 'UpstreamTimeoutError';
  }
}

export class UpstreamAuthError extends MCPError {
  constructor(providerName: string) {
    const correlationId = generateCorrelationId();
    super(
      sanitizeAuthErrorMessage('Authentication failed for upstream provider'),
      'UPSTREAM_AUTH_ERROR',
      { correlationId, providerName },
    );
    this.name = 'UpstreamAuthError';
  }
}

export class UpstreamMalformedResponseError extends MCPError {
  constructor(providerName: string, reason: string) {
    const correlationId = generateCorrelationId();
    super(
      sanitizeAuthErrorMessage(
        `Malformed response from upstream provider '${providerName}': ${reason}`,
      ),
      'UPSTREAM_MALFORMED_RESPONSE',
      { correlationId, providerName },
    );
    this.name = 'UpstreamMalformedResponseError';
  }
}

