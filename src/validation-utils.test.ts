import { describe, it, expect } from 'vitest';
import { isEmail, isUri, redactHeader, redactQueryParam, redactParam } from './validation-utils.js';

describe('Validation Utils', () => {
  describe('isEmail', () => {
    it('should validate correct email addresses', () => {
      expect(isEmail('user@example.com')).toBe(true);
      expect(isEmail('test.email+tag@domain.co.uk')).toBe(true);
      expect(isEmail('user_name@subdomain.example.org')).toBe(true);
    });

    it('should reject invalid email addresses', () => {
      expect(isEmail('invalid')).toBe(false);
      expect(isEmail('@example.com')).toBe(false);
      expect(isEmail('user@')).toBe(false);
      expect(isEmail('user.example.com')).toBe(false);
      expect(isEmail('user@.com')).toBe(false);
      expect(isEmail('')).toBe(false);
    });
  });

  describe('isUri', () => {
    it('should validate correct URIs', () => {
      expect(isUri('https://example.com')).toBe(true);
      expect(isUri('http://localhost:3000')).toBe(true);
      expect(isUri('ftp://ftp.example.com/file.txt')).toBe(true);
      expect(isUri('mailto:user@example.com')).toBe(true);
      expect(isUri('file:///path/to/file')).toBe(true);
    });

    it('should reject invalid URIs', () => {
      expect(isUri('not-a-url')).toBe(false);
      expect(isUri('')).toBe(false);
      expect(isUri('example.com')).toBe(false);
      expect(isUri('://invalid')).toBe(false);
    });
  });

  describe('redactHeader', () => {
    it('should redact matching header case-insensitively', () => {
      const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
      const redacted = redactHeader(headers, 'authorization');
      expect(redacted.Authorization).toBe('[REDACTED]');
      expect(redacted['Content-Type']).toBe('application/json');
    });

    it('should return empty object for undefined headers', () => {
      const redacted = redactHeader(undefined, 'authorization');
      expect(redacted).toEqual({});
    });
  });

  describe('redactQueryParam', () => {
    it('should redact matching query parameter', () => {
      const url = 'https://example.com/api?token=secret&other=value';
      const redacted = redactQueryParam(url, 'token');
      expect(redacted).toContain('token=%5BREDACTED%5D');
      expect(redacted).toContain('other=value');
    });

    it('should return empty string for undefined url', () => {
      expect(redactQueryParam(undefined, 'token')).toBe('');
    });

    it('should fallback to manual parsing for invalid URL', () => {
      const invalidUrl = '/api?token=secret&other=value';
      const redacted = redactQueryParam(invalidUrl, 'token');
      expect(redacted).toBe('/api?token=%5BREDACTED%5D&other=value');
    });

    it('should leave URL unchanged when no query string present', () => {
      const url = 'https://example.com/path';
      expect(redactQueryParam(url, 'token')).toBe(url);
    });

    it('should return original for unsafe param name', () => {
      const url = 'https://example.com/api?token=secret';
      expect(redactQueryParam(url, 'token!')).toBe(url);
    });
  });

  describe('redactParam', () => {
    it('should redact matching param in object', () => {
      const params = { api_key: 'secret', name: 'test' };
      const redacted = redactParam(params, 'api_key');
      expect(redacted.api_key).toBe('[REDACTED]');
      expect(redacted.name).toBe('test');
    });

    it('should return empty object for non-object params', () => {
      const redacted = redactParam('string', 'param');
      expect(redacted).toEqual({});
    });
  });
});
