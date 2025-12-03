/**
 * Logger tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConsoleLogger, JsonLogger, LogLevel } from './logger.js';
import type { AuthInterceptor } from './types/profile.js';

describe('ConsoleLogger', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete process.env.MCP4_LOG_LEVEL;
  });

  it('logs info messages at INFO level', () => {
    const logger = new ConsoleLogger(LogLevel.INFO);
    logger.info('test message', { key: 'value' });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[.*\] INFO: test message {"key":"value"}/)
    );
  });

  it('filters out debug messages at INFO level', () => {
    const logger = new ConsoleLogger(LogLevel.INFO);
    logger.debug('debug message');

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('logs debug messages at DEBUG level', () => {
    const logger = new ConsoleLogger(LogLevel.DEBUG);
    logger.debug('debug message');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[.*\] DEBUG: debug message/)
    );
  });

  it('logs error with stack trace', () => {
    const logger = new ConsoleLogger(LogLevel.ERROR);
    const error = new Error('test error');
    logger.error('operation failed', error);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/ERROR: operation failed.*"error":"test error"/)
    );
  });

  it('respects MCP4_LOG_LEVEL env var', () => {
    process.env.MCP4_LOG_LEVEL = 'WARN';
    const logger = new ConsoleLogger();
    
    logger.info('info message');
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    logger.warn('warn message');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/WARN: warn message/)
    );
  });

  it('defaults to INFO for invalid MCP4_LOG_LEVEL', () => {
    process.env.MCP4_LOG_LEVEL = 'INVALID';
    const logger = new ConsoleLogger();
    
    logger.debug('debug message');
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    logger.info('info message');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/INFO: info message/)
    );
  });

  it('respects DEBUG env level', () => {
    process.env.MCP4_LOG_LEVEL = 'DEBUG';
    const logger = new ConsoleLogger();
    
    logger.debug('debug message');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/DEBUG: debug message/)
    );
  });

  it('silences all logs at SILENT level', () => {
    const logger = new ConsoleLogger(LogLevel.SILENT);
    
    logger.debug('debug');
    logger.info('info');
    logger.warn('warn');
    logger.error('error');

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('JsonLogger', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete process.env.MCP4_LOG_LEVEL;
  });

  it('outputs valid JSON', () => {
    const logger = new JsonLogger(LogLevel.INFO);
    logger.info('test message', { key: 'value' });

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = consoleErrorSpy.mock.calls[0][0];
    const parsed = JSON.parse(output as string);

    expect(parsed).toMatchObject({
      level: 'info',
      message: 'test message',
      key: 'value',
    });
    expect(parsed.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('includes error details in JSON', () => {
    const logger = new JsonLogger(LogLevel.ERROR);
    const error = new Error('test error');
    logger.error('operation failed', error, { context: 'test' });

    const output = consoleErrorSpy.mock.calls[0][0];
    const parsed = JSON.parse(output as string);

    expect(parsed).toMatchObject({
      level: 'error',
      message: 'operation failed',
      error: 'test error',
      context: 'test',
    });
    expect(parsed.stack).toBeDefined();
  });

  it('filters by log level', () => {
    const logger = new JsonLogger(LogLevel.WARN);
    
    logger.debug('debug');
    logger.info('info');
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    logger.warn('warn');
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });

  it('outputs debug messages at DEBUG level', () => {
    const logger = new JsonLogger(LogLevel.DEBUG);
    logger.debug('debug message', { key: 'value' });

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = consoleErrorSpy.mock.calls[0][0];
    const parsed = JSON.parse(output as string);

    expect(parsed).toMatchObject({
      level: 'debug',
      message: 'debug message',
      key: 'value',
    });
  });

  it('uses MCP4_LOG_LEVEL env var for default level', () => {
    process.env.MCP4_LOG_LEVEL = 'DEBUG';
    const logger = new JsonLogger();
    logger.debug('debug via env');

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const output = consoleErrorSpy.mock.calls[0][0];
    const parsed = JSON.parse(output as string);

    expect(parsed.level).toBe('debug');
    expect(parsed.message).toBe('debug via env');
  });
});

describe('Token Redaction', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('Bearer auth', () => {
    it('should redact Authorization header in ConsoleLogger', () => {
      const authConfig: AuthInterceptor = {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN'
      };
      
      const logger = new ConsoleLogger(LogLevel.INFO, authConfig);
      logger.info('Request', {
        headers: { Authorization: 'Bearer secret-token-12345' }
      });
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[REDACTED\]/)
      );
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('secret-token-12345')
      );
    });

    it('should redact authorization header (lowercase) in JsonLogger', () => {
      const authConfig: AuthInterceptor = {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN'
      };
      
      const logger = new JsonLogger(LogLevel.INFO, authConfig);
      logger.info('Request', {
        headers: { authorization: 'Bearer secret-token-12345' }
      });
      
      const call = consoleErrorSpy.mock.calls[0][0];
      expect(call).toContain('[REDACTED]');
      expect(call).not.toContain('secret-token-12345');
    });
  });

  describe('Query auth', () => {
    it('should redact query parameter in URL', () => {
      const authConfig: AuthInterceptor = {
        type: 'query',
        query_param: 'api_key',
        value_from_env: 'MCP4_API_TOKEN'
      };
      
      const logger = new ConsoleLogger(LogLevel.INFO, authConfig);
      logger.info('Request', {
        url: 'https://api.example.com/users?api_key=secret123&page=1'
      });
      
      // URL is JSON-stringified, so [REDACTED] becomes %5BREDACTED%5D
      const call = consoleErrorSpy.mock.calls[0][0];
      expect(call).toMatch(/api_key=(\\[REDACTED\\]|%5BREDACTED%5D)/);
      expect(call).not.toContain('secret123');
    });

    it('should redact query parameter in params object', () => {
      const authConfig: AuthInterceptor = {
        type: 'query',
        query_param: 'api_key',
        value_from_env: 'MCP4_API_TOKEN'
      };
      
      const logger = new JsonLogger(LogLevel.INFO, authConfig);
      logger.info('Request', {
        params: { api_key: 'secret123', page: 1 }
      });
      
      const call = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(call as string);
      expect(parsed.params.api_key).toBe('[REDACTED]');
      expect(parsed.params.page).toBe(1);
    });

    it('should handle relative URLs', () => {
      const authConfig: AuthInterceptor = {
        type: 'query',
        query_param: 'token',
        value_from_env: 'MCP4_API_TOKEN'
      };
      
      const logger = new ConsoleLogger(LogLevel.INFO, authConfig);
      logger.info('Request', {
        url: '/api/users?token=secret&limit=10'
      });
      
      const call = consoleErrorSpy.mock.calls[0][0];
      expect(call).toContain('token=%5BREDACTED%5D');
      expect(call).not.toContain('secret');
    });
  });

  describe('Custom header auth', () => {
    it('should redact custom header', () => {
      const authConfig: AuthInterceptor = {
        type: 'custom-header',
        header_name: 'X-API-Key',
        value_from_env: 'MCP4_API_TOKEN'
      };
      
      const logger = new ConsoleLogger(LogLevel.INFO, authConfig);
      logger.info('Request', {
        headers: { 
          'X-API-Key': 'secret-api-key-12345',
          'User-Agent': 'mcp-client/1.0'
        }
      });
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[REDACTED\]/)
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('User-Agent')  // Other headers OK
      );
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('secret-api-key-12345')
      );
    });

    it('should be case-insensitive for header names', () => {
      const authConfig: AuthInterceptor = {
        type: 'custom-header',
        header_name: 'X-API-Key',
        value_from_env: 'MCP4_API_TOKEN'
      };
      
      const logger = new JsonLogger(LogLevel.INFO, authConfig);
      logger.info('Request', {
        headers: { 'x-api-key': 'secret123' }  // lowercase
      });
      
      const call = consoleErrorSpy.mock.calls[0][0];
      expect(call).toContain('[REDACTED]');
      expect(call).not.toContain('secret123');
    });
  });

  describe('No auth config', () => {
    it('should not redact when no auth config provided', () => {
      const logger = new ConsoleLogger(LogLevel.INFO);
      logger.info('Request', {
        headers: { Authorization: 'Bearer token123' },
        params: { api_key: 'key123' }
      });
      
      // Should log as-is without redaction
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Bearer token123')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('key123')
      );
    });
  });
});

