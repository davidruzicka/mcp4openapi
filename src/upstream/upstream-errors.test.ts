import { describe, expect, it } from 'vitest';
import {
  UpstreamConnectionError,
  UpstreamTimeoutError,
  UpstreamAuthError,
  UpstreamMalformedResponseError,
  toMcpErrorResponse,
} from './upstream-errors.js';
import { MCPError } from '../core/errors.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('upstream-errors', () => {
  describe('UpstreamConnectionError', () => {
    it('has correct code and details', () => {
      const err = new UpstreamConnectionError('connect failed', 'provider-a', { url: 'https://x' });
      expect(err.code).toBe('UPSTREAM_CONNECTION_ERROR');
      expect(err.details?.providerName).toBe('provider-a');
      expect(err.details?.url).toBe('https://x');
      expect(err.message).toContain('connect failed');
    });

    it('is instanceof MCPError', () => {
      const err = new UpstreamConnectionError('msg', 'p');
      expect(err).toBeInstanceOf(MCPError);
      expect(err).toBeInstanceOf(Error);
    });

    it('has a UUID correlationId', () => {
      const err = new UpstreamConnectionError('msg', 'p');
      expect(err.details?.correlationId).toMatch(UUID_REGEX);
    });
  });

  describe('UpstreamTimeoutError', () => {
    it('has correct code and message', () => {
      const err = new UpstreamTimeoutError('provider-b', 5000);
      expect(err.code).toBe('UPSTREAM_TIMEOUT');
      expect(err.message).toContain('provider-b');
      expect(err.message).toContain('5000');
      expect(err.details?.providerName).toBe('provider-b');
    });

    it('is instanceof MCPError', () => {
      expect(new UpstreamTimeoutError('p', 1000)).toBeInstanceOf(MCPError);
    });

    it('has a UUID correlationId', () => {
      const err = new UpstreamTimeoutError('p', 1000);
      expect(err.details?.correlationId).toMatch(UUID_REGEX);
    });
  });

  describe('UpstreamAuthError', () => {
    it('has correct code', () => {
      const err = new UpstreamAuthError('provider-c');
      expect(err.code).toBe('UPSTREAM_AUTH_ERROR');
      expect(err.details?.providerName).toBe('provider-c');
    });

    it('message does not contain credential values or provider name', () => {
      const err = new UpstreamAuthError('provider-c');
      expect(err.message).not.toContain('Bearer');
      expect(err.message).not.toMatch(/eyJ[A-Za-z0-9_-]+/);
      expect(err.message).not.toContain('provider-c');
    });

    it('is instanceof MCPError', () => {
      expect(new UpstreamAuthError('p')).toBeInstanceOf(MCPError);
    });

    it('has a UUID correlationId', () => {
      const err = new UpstreamAuthError('p');
      expect(err.details?.correlationId).toMatch(UUID_REGEX);
    });
  });

  describe('UpstreamMalformedResponseError', () => {
    it('has correct code and reason in message', () => {
      const err = new UpstreamMalformedResponseError('provider-d', 'invalid json');
      expect(err.code).toBe('UPSTREAM_MALFORMED_RESPONSE');
      expect(err.message).toContain('invalid json');
      expect(err.details?.providerName).toBe('provider-d');
    });

    it('is instanceof MCPError', () => {
      expect(new UpstreamMalformedResponseError('p', 'bad')).toBeInstanceOf(MCPError);
    });

    it('has a UUID correlationId', () => {
      const err = new UpstreamMalformedResponseError('p', 'bad');
      expect(err.details?.correlationId).toMatch(UUID_REGEX);
    });
  });

  describe('sanitization', () => {
    it('sanitizes JWT-pattern strings from error messages', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv';
      const err = new UpstreamConnectionError(`failed with ${jwt}`, 'p');
      expect(err.message).not.toContain(jwt);
      expect(err.message).toContain('[REDACTED_JWT]');
    });
  });

  describe('toMcpErrorResponse', () => {
    it('returns correct shape with no stack property', () => {
      const err = new UpstreamConnectionError('test msg', 'prov');
      const response = toMcpErrorResponse(err);

      expect(response.code).toBe(-32603);
      expect(response.message).toContain('test msg');
      expect(response.data).toBeDefined();
      expect(response.data?.correlationId).toMatch(UUID_REGEX);
      expect(response.data?.code).toBe('UPSTREAM_CONNECTION_ERROR');
      expect('stack' in response).toBe(false);
      expect(response.data && 'stack' in response.data).toBe(false);
    });

    it('sanitizes error messages in the response', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv';
      const err = new UpstreamConnectionError(`token was ${jwt}`, 'p');
      const response = toMcpErrorResponse(err);
      expect(response.message).not.toContain(jwt);
    });

    it('omits data when correlationId is absent', () => {
      const err = new MCPError('bare error', 'SOME_CODE');
      const response = toMcpErrorResponse(err);
      expect(response.code).toBe(-32603);
      expect(response.message).toBeDefined();
      expect(response.data).toBeUndefined();
    });
  });
});
