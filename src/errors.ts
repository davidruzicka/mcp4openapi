/**
 * Structured error types for MCP server
 *
 * Provides type-safe error handling with machine-readable error codes
 * and structured error details for better debugging and client handling.
 */

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
  // Simple UUID v4 implementation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
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
