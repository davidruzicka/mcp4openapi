/**
 * Tests for error utilities
 */

import { describe, it, expect } from 'vitest';
import { 
  generateCorrelationId, 
  isMCPError, 
  getErrorDetails,
  MCPError,
  ValidationError,
  OperationNotFoundError,
  ResourceNotFoundError,
  ParameterError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  NetworkError,
  ConfigurationError,
  SessionError,
  UnknownCliFlagError
} from './errors.js';

describe('Error Classes', () => {
  describe('MCPError', () => {
    it('should create error with code and details', () => {
      const error = new MCPError('test message', 'TEST_CODE', { key: 'value' });
      expect(error.message).toBe('test message');
      expect(error.code).toBe('TEST_CODE');
      expect(error.details).toEqual({ key: 'value' });
      expect(error.name).toBe('MCPError');
    });
  });

  describe('ParameterError', () => {
    it('should format message with param name and reason', () => {
      const error = new ParameterError('userId', 'must be a positive integer');
      expect(error.message).toBe("Invalid parameter 'userId': must be a positive integer");
      expect(error.code).toBe('PARAMETER_ERROR');
      expect(error.details).toEqual({ paramName: 'userId', reason: 'must be a positive integer' });
      expect(error.name).toBe('ParameterError');
    });
  });

  describe('ResourceNotFoundError', () => {
    it('should format message with resource and default type', () => {
      const error = new ResourceNotFoundError('abc');
      expect(error.message).toBe('Resource not found: abc');
      expect(error.code).toBe('RESOURCE_NOT_FOUND');
      expect(error.details).toEqual({ resource: 'abc', resourceType: 'Resource' });
      expect(error.name).toBe('ResourceNotFoundError');
    });

    it('should format message with custom resource type', () => {
      const error = new ResourceNotFoundError('user-1', 'User');
      expect(error.message).toBe('User not found: user-1');
      expect(error.details).toEqual({ resource: 'user-1', resourceType: 'User' });
    });
  });

  describe('UnknownCliFlagError', () => {
    it('should sort flags and include them in details', () => {
      const error = new UnknownCliFlagError(['--z', '--a']);
      expect(error.message).toBe('Unknown CLI flags: --a, --z');
      expect(error.code).toBe('UNKNOWN_CLI_FLAG');
      expect(error.details).toEqual({ flags: ['--a', '--z'] });
      expect(error.name).toBe('UnknownCliFlagError');
    });
  });

  describe('SessionError', () => {
    it('should include sessionId in details when provided', () => {
      const error = new SessionError('Session expired', 'abc-123');
      expect(error.message).toBe('Session expired');
      expect(error.code).toBe('SESSION_ERROR');
      expect(error.details).toEqual({ sessionId: 'abc-123' });
      expect(error.name).toBe('SessionError');
    });

    it('should work without sessionId', () => {
      const error = new SessionError('No active session');
      expect(error.message).toBe('No active session');
      expect(error.details).toBeUndefined();
    });
  });
});

describe('isMCPError', () => {
  it('should return true for MCPError instances', () => {
    expect(isMCPError(new MCPError('test', 'CODE'))).toBe(true);
    expect(isMCPError(new ValidationError('test'))).toBe(true);
    expect(isMCPError(new OperationNotFoundError('op1'))).toBe(true);
    expect(isMCPError(new ResourceNotFoundError('res1'))).toBe(true);
    expect(isMCPError(new ParameterError('param', 'reason'))).toBe(true);
    expect(isMCPError(new AuthenticationError())).toBe(true);
    expect(isMCPError(new AuthorizationError())).toBe(true);
    expect(isMCPError(new RateLimitError('limit exceeded'))).toBe(true);
    expect(isMCPError(new NetworkError('network failed'))).toBe(true);
    expect(isMCPError(new ConfigurationError('bad config'))).toBe(true);
    expect(isMCPError(new SessionError('session issue'))).toBe(true);
    expect(isMCPError(new UnknownCliFlagError(['--x']))).toBe(true);
  });

  it('should return false for non-MCPError', () => {
    expect(isMCPError(new Error('plain error'))).toBe(false);
    expect(isMCPError('string error')).toBe(false);
    expect(isMCPError(null)).toBe(false);
    expect(isMCPError(undefined)).toBe(false);
    expect(isMCPError({ message: 'object' })).toBe(false);
  });
});

describe('getErrorDetails', () => {
  it('should extract details from MCPError', () => {
    const error = new ConfigurationError('missing config', { configKey: 'API_KEY' });
    const details = getErrorDetails(error);
    
    expect(details.name).toBe('ConfigurationError');
    expect(details.code).toBe('CONFIGURATION_ERROR');
    expect(details.message).toBe('missing config');
    expect(details.details).toEqual({ configKey: 'API_KEY' });
    expect(details.stack).toBeDefined();
  });

  it('should extract details from plain Error', () => {
    const error = new Error('plain error');
    const details = getErrorDetails(error);
    
    expect(details.name).toBe('Error');
    expect(details.message).toBe('plain error');
    expect(details.stack).toBeDefined();
    expect(details.code).toBeUndefined();
  });

  it('should handle non-error values', () => {
    expect(getErrorDetails('string error')).toEqual({ message: 'string error' });
    expect(getErrorDetails(42)).toEqual({ message: '42' });
    expect(getErrorDetails(null)).toEqual({ message: 'null' });
  });
});

describe('generateCorrelationId', () => {
  it('should generate a valid UUID v4 format', () => {
    const id = generateCorrelationId();
    
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(id).toMatch(uuidRegex);
  });

  it('should generate unique IDs', () => {
    const ids = new Set<string>();
    
    // Generate 100 IDs and check for uniqueness
    for (let i = 0; i < 100; i++) {
      const id = generateCorrelationId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    
    expect(ids.size).toBe(100);
  });

  it('should have correct version (4) in UUID', () => {
    const id = generateCorrelationId();
    const parts = id.split('-');
    
    // Version should be 4 (first character of third group)
    expect(parts[2][0]).toBe('4');
  });

  it('should have correct variant in UUID', () => {
    const id = generateCorrelationId();
    const parts = id.split('-');
    
    // Variant should be 8, 9, a, or b (first character of fourth group)
    expect(['8', '9', 'a', 'b']).toContain(parts[3][0]);
  });
});
