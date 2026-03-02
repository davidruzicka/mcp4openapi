/**
 * Structured error types for MCP server
 *
 * Provides type-safe error handling with machine-readable error codes
 * and structured error details for better debugging and client handling.
 */

import { randomUUID } from 'node:crypto';

export class MCPError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'MCPError';
  }
}

export class ValidationError extends MCPError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class OperationNotFoundError extends MCPError {
  constructor(operationId: string) {
    super(
      `Operation not found: ${operationId}`,
      'OPERATION_NOT_FOUND',
      { operationId }
    );
    this.name = 'OperationNotFoundError';
  }
}

export class ResourceNotFoundError extends MCPError {
  constructor(resource: string, resourceType: string = 'Resource') {
    super(
      `${resourceType} not found: ${resource}`,
      'RESOURCE_NOT_FOUND',
      { resource, resourceType }
    );
    this.name = 'ResourceNotFoundError';
  }
}

export class ParameterError extends MCPError {
  constructor(paramName: string, reason: string) {
    super(
      `Invalid parameter '${paramName}': ${reason}`,
      'PARAMETER_ERROR',
      { paramName, reason }
    );
    this.name = 'ParameterError';
  }
}

export class AuthenticationError extends MCPError {
  constructor(message: string = 'Authentication required', details?: Record<string, unknown>) {
    super(message, 'AUTHENTICATION_ERROR', details);
    this.name = 'AuthenticationError';
  }
}

export class SessionCookieLoginError extends MCPError {
  constructor(message: string = 'Session cookie login failed', details?: Record<string, unknown>) {
    super(message, 'SESSION_COOKIE_LOGIN_ERROR', details);
    this.name = 'SessionCookieLoginError';
  }
}

export class SessionCookieMissingError extends MCPError {
  constructor(message: string = 'Expected session cookie was not returned', details?: Record<string, unknown>) {
    super(message, 'SESSION_COOKIE_MISSING', details);
    this.name = 'SessionCookieMissingError';
  }
}

export class SessionCookieExpiredError extends MCPError {
  constructor(message: string = 'Session cookie expired', details?: Record<string, unknown>) {
    super(message, 'SESSION_COOKIE_EXPIRED', details);
    this.name = 'SessionCookieExpiredError';
  }
}

export class SessionCookieBackoffError extends MCPError {
  constructor(message: string = 'Session cookie relogin temporarily suspended', details?: Record<string, unknown>) {
    super(message, 'SESSION_COOKIE_BACKOFF', details);
    this.name = 'SessionCookieBackoffError';
  }
}

export class AuthorizationError extends MCPError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 'AUTHORIZATION_ERROR');
    this.name = 'AuthorizationError';
  }
}

export class RateLimitError extends MCPError {
  constructor(message: string, retryAfter?: number) {
    super(message, 'RATE_LIMIT_EXCEEDED', retryAfter ? { retryAfter } : undefined);
    this.name = 'RateLimitError';
  }
}

export class OAuthClientStoreCapacityError extends MCPError {
  constructor(
    message: string = 'OAuth client registration temporarily unavailable',
    details?: Record<string, unknown>,
  ) {
    super(message, 'OAUTH_CLIENT_STORE_CAPACITY', details);
    this.name = 'OAuthClientStoreCapacityError';
  }
}

export class NetworkError extends MCPError {
  constructor(message: string, statusCode?: number, details?: Record<string, unknown>) {
    super(message, 'NETWORK_ERROR', { statusCode, ...details });
    this.name = 'NetworkError';
  }
}

export class ConfigurationError extends MCPError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIGURATION_ERROR', details);
    this.name = 'ConfigurationError';
  }
}

export class SessionError extends MCPError {
  constructor(message: string, sessionId?: string) {
    super(message, 'SESSION_ERROR', sessionId ? { sessionId } : undefined);
    this.name = 'SessionError';
  }
}

export class UnknownCliFlagError extends MCPError {
  constructor(flags: string[]) {
    const sortedFlags = [...flags].sort();
    super(
      `Unknown CLI flags: ${sortedFlags.join(', ')}`,
      'UNKNOWN_CLI_FLAG',
      { flags: sortedFlags }
    );
    this.name = 'UnknownCliFlagError';
  }
}

/**
 * Helper function to check if an error is an MCPError
 */
export function isMCPError(error: unknown): error is MCPError {
  return error instanceof MCPError;
}

/**
 * Generate a unique correlation ID for error tracking
 * 
 * Why: Allows matching client-reported errors with server logs
 */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Helper function to get error details for logging
 */
export function getErrorDetails(error: unknown): Record<string, unknown> {
  if (isMCPError(error)) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details,
      stack: error.stack,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}
