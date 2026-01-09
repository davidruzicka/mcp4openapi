import { describe, it, expect, vi } from 'vitest';
import { GlobalToolFilter } from './global-tool-filter.js';
import type { ToolFilterConfig } from '../types.js';
import type { ToolDefinition } from '../../types/profile.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';

describe('GlobalToolFilter', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };

  describe('apply filtering', () => {
    it('allows all tools when no config', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get user', parameters: {} },
        { name: 'list_users', description: 'List users', parameters: {} }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(),
        hasAllowRules: false,
        sources: { allowList: [], allowRegex: [], denyList: [], denyRegex: [], allowCategories: [] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(2);
      expect(result.removed).toHaveLength(0);
    });

    it('filters by allow list', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(['get_user']),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(),
        hasAllowRules: true,
        sources: { allowList: ['get_user'], allowRegex: [], denyList: [], denyRegex: [], allowCategories: [] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(1);
      expect(result.allowed[0].name).toBe('get_user');
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].name).toBe('delete_user');
    });

    it('filters by deny list', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(['delete_user']),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(),
        hasAllowRules: false,
        sources: { allowList: [], allowRegex: [], denyList: ['delete_user'], denyRegex: [], allowCategories: [] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(1);
      expect(result.allowed[0].name).toBe('get_user');
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].name).toBe('delete_user');
    });

    it('filters by regex patterns', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'read_project', description: 'Read', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const allowPattern = compiler.compile('get_.*|read_.*', 'test');
      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(),
        allowRegex: [allowPattern],
        denyRegex: [],
        allowCategories: new Set(),
        hasAllowRules: true,
        sources: { allowList: [], allowRegex: ['get_.*|read_.*'], denyList: [], denyRegex: [], allowCategories: [] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(2);
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].name).toBe('delete_user');
    });

    it('deny rules take precedence over allow rules', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'get_admin', description: 'Get admin', parameters: {} }
      ];

      const allowPattern = compiler.compile('get_.*', 'test');
      const denyPattern = compiler.compile('.*_admin', 'test');

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(),
        allowRegex: [allowPattern],
        denyRegex: [denyPattern],
        allowCategories: new Set(),
        hasAllowRules: true,
        sources: { allowList: [], allowRegex: ['get_.*'], denyList: [], denyRegex: ['.*_admin'], allowCategories: [] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(1);
      expect(result.allowed[0].name).toBe('get_user');
      expect(result.removed[0].name).toBe('get_admin');
    });
  });

  describe('reasons tracking', () => {
    it('tracks removal reasons', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(['get_user']),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(),
        hasAllowRules: true,
        sources: { allowList: ['get_user'], allowRegex: [], denyList: [], denyRegex: [], allowCategories: [] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any);
      const result = filter.apply(tools);

      expect(result.reasons.has('delete_user')).toBe(true);
      expect(result.reasons.get('delete_user')).toContain('no_allow_match');
    });
  });

  describe('logging', () => {
    it('logs filtered tools', () => {
      const tools: ToolDefinition[] = [
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(['delete_user']),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(),
        hasAllowRules: false,
        sources: { allowList: [], allowRegex: [], denyList: ['delete_user'], denyRegex: [], allowCategories: [] }
      };

      mockLogger.info.mockClear();
      const filter = new GlobalToolFilter(config, mockLogger as any);
      filter.apply(tools);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Tool filtered',
        expect.objectContaining({
          filter_source: 'env',
          tool: 'delete_user',
          action: 'removed'
        })
      );
    });
  });

  describe('summary generation', () => {
    it('generates summary', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(['get_user']),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(),
        hasAllowRules: true,
        sources: { allowList: ['get_user'], allowRegex: [], denyList: [], denyRegex: [], allowCategories: [] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any);
      const result = filter.apply(tools);

      expect(result.summary).toEqual({
        originalCount: 2,
        allowedCount: 1,
        removedCount: 1
      });
    });
  });
});
