import { describe, it, expect } from 'vitest';
import { normalizeToolFilterHeaderValue, applySessionToolFilter, parseSessionToolFilterHeader } from './compat.js';
import type { ToolDefinition } from '../types/profile.js';

describe('compat functions', () => {
  describe('normalizeToolFilterHeaderValue', () => {
    it('returns undefined for empty string', () => {
      const result = normalizeToolFilterHeaderValue('');
      expect(result).toBeUndefined();
    });

    it('returns undefined for whitespace-only string', () => {
      const result = normalizeToolFilterHeaderValue('   ');
      expect(result).toBeUndefined();
    });

    it('returns trimmed value for non-empty string', () => {
      const result = normalizeToolFilterHeaderValue('  get_user  ');
      expect(result).toBe('get_user');
    });

    it('returns undefined for undefined input', () => {
      const result = normalizeToolFilterHeaderValue(undefined);
      expect(result).toBeUndefined();
    });

    it('returns undefined for null input', () => {
      const result = normalizeToolFilterHeaderValue(null as any);
      expect(result).toBeUndefined();
    });
  });

  describe('applySessionToolFilter', () => {
    const tools: ToolDefinition[] = [
      { name: 'get_user', description: 'Get', parameters: {} },
      { name: 'list_users', description: 'List', parameters: {} }
    ];

    it('works without resolver (detector undefined)', () => {
      const request = parseSessionToolFilterHeader('get_user');
      const result = applySessionToolFilter(tools, request);
      
      expect(result.allowedToolNames.has('get_user')).toBe(true);
      expect(result.allowedToolNames.has('list_users')).toBe(false);
    });

    it('works with resolver', () => {
      const request = parseSessionToolFilterHeader('get_user');
      const resolver = {
        getOperationById: (id: string) => undefined,
        getOperationForCall: (call: string) => undefined
      };
      
      const result = applySessionToolFilter(tools, request, resolver);
      
      expect(result.allowedToolNames.has('get_user')).toBe(true);
    });
  });
});
