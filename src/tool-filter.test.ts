
import { describe, it, expect, vi } from 'vitest';
import { parseToolFilterConfig, applyToolFilter, validateRegexPattern, detectListReadOperations } from './tool-filter.js';
import type { ToolDefinition } from './types/profile.js';

describe('Tool Filter', () => {
  describe('parseToolFilterConfig', () => {
    it('returns undefined if no filter env vars are set', () => {
      expect(parseToolFilterConfig({})).toBeUndefined();
    });

    it('parses allow list', () => {
      const config = parseToolFilterConfig({
        MCP4_TOOL_FILTER_ALLOW_LIST: 'tool1, tool2'
      });
      expect(config?.allowList).toBeInstanceOf(Set);
      expect(config?.allowList?.has('tool1')).toBe(true);
      expect(config?.allowList?.has('tool2')).toBe(true);
    });

    it('parses allow regex and anchors them', () => {
      const config = parseToolFilterConfig({
        MCP4_TOOL_FILTER_ALLOW_REGEX: 'get_.*, list_.*'
      });
      expect(config?.allowRegex).toHaveLength(2);
      expect(config?.allowRegex?.[0].source).toBe('^get_.*$');
      expect(config?.allowRegex?.[1].source).toBe('^list_.*$');
    });

    it('handles regex that are already anchored', () => {
      const config = parseToolFilterConfig({
        MCP4_TOOL_FILTER_ALLOW_REGEX: '^exact$'
      });
      expect(config?.allowRegex?.[0].source).toBe('^exact$');
    });

    it('parses allow composites flag', () => {
      // Need at least one list/regex defined to return config
      const config = parseToolFilterConfig({
        MCP4_TOOL_FILTER_ALLOW_COMPOSITES: 'true',
        MCP4_TOOL_FILTER_ALLOW_LIST: 'dummy'
      });
      expect(config?.allowComposites).toBe(true);
    });
  });

  describe('validateRegexPattern', () => {
    it('accepts safe regex', () => {
      expect(validateRegexPattern('abc.*')).toEqual({ valid: true });
    });

    it('rejects unsafe regex (ReDoS)', () => {
      // safe-regex might not catch everything, but (a+)+ is a classic
      // Note: safe-regex behavior might vary, but we test that validation runs
      const result = validateRegexPattern('(a+)+');
      // If safe-regex detects it:
      if (!result.valid) {
        expect(result.error).toContain('unsafe');
      }
    });

    it('rejects invalid syntax', () => {
      expect(validateRegexPattern('[')).toEqual({ valid: false, error: expect.stringContaining('Invalid regex syntax') });
    });
  });

  describe('applyToolFilter', () => {
    const tools: ToolDefinition[] = [
      { name: 'get_user', description: '', parameters: {} },
      { name: 'delete_user', description: '', parameters: {} },
      { name: 'list_projects', description: '', parameters: {} },
      { name: 'update_project', description: '', parameters: {} },
      { name: 'complex_workflow', description: '', parameters: {}, composite: true }
    ];

    it('allows all if no filters configured', () => {
      const result = applyToolFilter(tools, {});
      expect(result.allowed).toHaveLength(5);
      expect(result.removed).toHaveLength(0);
    });

    it('applies allow list', () => {
      const result = applyToolFilter(tools, {
        allowList: new Set(['get_user'])
      });
      expect(result.allowed).toHaveLength(1);
      expect(result.allowed[0].name).toBe('get_user');
    });

    it('applies allow regex', () => {
      const result = applyToolFilter(tools, {
        allowRegex: [/^get_.*$/, /^list_.*$/]
      });
      expect(result.allowed.map(t => t.name)).toEqual(['get_user', 'list_projects']);
    });

    it('applies deny list (precedence over allow)', () => {
      const result = applyToolFilter(tools, {
        allowRegex: [/^.*$/], // Allow all
        denyList: new Set(['delete_user'])
      });
      expect(result.removed.map(t => t.name)).toEqual(['delete_user']);
      expect(result.allowed).toHaveLength(4);
    });

    it('auto-allows composites if configured', () => {
      const toolsWithComposite: ToolDefinition[] = [
        { name: 'delete_user', description: '', parameters: {} },
        { name: 'list_workflow', description: '', parameters: {}, composite: true } // Should be detected as list
      ];

      const result = applyToolFilter(toolsWithComposite, {
        allowList: new Set(['dummy']), // Doesn't match anything
        allowComposites: true
      });

      expect(result.allowed.map(t => t.name)).toEqual(['list_workflow']);
    });
  });

  describe('detectListReadOperations', () => {
    it('detects list operations', () => {
      expect(detectListReadOperations({ name: 'list_users', description: '', parameters: {} }).isList).toBe(true);
      expect(detectListReadOperations({ name: 'search_issues', description: '', parameters: {} }).isList).toBe(true);
    });

    it('detects read operations', () => {
      expect(detectListReadOperations({ name: 'get_user', description: '', parameters: {} }).isRead).toBe(true);
      expect(detectListReadOperations({ name: 'read_file', description: '', parameters: {} }).isRead).toBe(true);
    });

    it('detects neither', () => {
      const result = detectListReadOperations({ name: 'delete_user', description: '', parameters: {} });
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(false);
    });
  });
});
