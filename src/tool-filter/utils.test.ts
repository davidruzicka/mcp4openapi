/**
 * Tests for tool-filter utility functions
 */

import { describe, it, expect } from 'vitest';
import { normalizeToolName } from './utils.js';

describe('tool-filter/utils', () => {
  describe('normalizeToolName', () => {
    it('should normalize composed and decomposed Unicode', () => {
      // Composed form (single character)
      const composed = 'café';
      // Decomposed form (e + combining acute accent)
      const decomposed = 'cafe\u0301';
      
      expect(normalizeToolName(composed)).toBe(normalizeToolName(decomposed));
      expect(normalizeToolName(composed)).toBe('café');
    });

    it('should handle ASCII names unchanged', () => {
      expect(normalizeToolName('manage_projects')).toBe('manage_projects');
      expect(normalizeToolName('list_users')).toBe('list_users');
    });

    it('should normalize various Unicode forms', () => {
      // German umlaut
      const umlaut = 'Müller';
      expect(normalizeToolName(umlaut)).toBe('Müller');
      
      // Japanese
      const japanese = 'プロジェクト';
      expect(normalizeToolName(japanese)).toBe('プロジェクト');
      
      // Emoji
      const emoji = 'test_🚀_tool';
      expect(normalizeToolName(emoji)).toBe('test_🚀_tool');
    });

    it('should handle empty string', () => {
      expect(normalizeToolName('')).toBe('');
    });

    it('should be idempotent', () => {
      const name = 'café_project';
      const normalized = normalizeToolName(name);
      expect(normalizeToolName(normalized)).toBe(normalized);
    });
  });
});
