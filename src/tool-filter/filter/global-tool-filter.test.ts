import { describe, it, expect, vi } from 'vitest';
import { GlobalToolFilter } from './global-tool-filter.js';
import type { ToolFilterConfig } from '../types.js';
import type { ToolDefinition } from '../../types/profile.js';
import type { OperationDetector } from '../operation/operation-detector.js';
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

  describe('category filtering', () => {
    it('filters by list category', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn((tool: ToolDefinition) => {
          if (tool.name === 'list_users') return { isList: true, isRead: false };
          if (tool.name === 'get_user') return { isList: false, isRead: true };
          return { isList: false, isRead: false };
        })
      } as any;

      const tools: ToolDefinition[] = [
        { name: 'list_users', description: 'List', parameters: {}, operations: { list: 'listOp' } },
        { name: 'get_user', description: 'Get', parameters: {}, operations: { read: 'getOp' } },
        { name: 'delete_user', description: 'Delete', parameters: {}, operations: { delete: 'deleteOp' } }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(['list']),
        hasAllowRules: true,
        sources: { allowList: [], allowRegex: [], denyList: [], denyRegex: [], allowCategories: ['list'] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any, mockDetector);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(1);
      expect(result.allowed[0].name).toBe('list_users');
      expect(result.removed).toHaveLength(2);
    });

    it('filters by read category', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn((tool: ToolDefinition) => {
          if (tool.name === 'get_user') return { isList: false, isRead: true };
          if (tool.name === 'list_users') return { isList: true, isRead: false };
          return { isList: false, isRead: false };
        })
      } as any;

      const tools: ToolDefinition[] = [
        { name: 'list_users', description: 'List', parameters: {}, operations: { list: 'listOp' } },
        { name: 'get_user', description: 'Get', parameters: {}, operations: { read: 'getOp' } },
        { name: 'delete_user', description: 'Delete', parameters: {}, operations: { delete: 'deleteOp' } }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(['read']),
        hasAllowRules: true,
        sources: { allowList: [], allowRegex: [], denyList: [], denyRegex: [], allowCategories: ['read'] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any, mockDetector);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(1);
      expect(result.allowed[0].name).toBe('get_user');
      expect(result.removed).toHaveLength(2);
    });

    it('filters by list+read categories (OR semantics)', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn((tool: ToolDefinition) => {
          if (tool.name === 'list_users') return { isList: true, isRead: false };
          if (tool.name === 'get_user') return { isList: false, isRead: true };
          if (tool.name === 'manage_items') return { isList: true, isRead: true };
          return { isList: false, isRead: false };
        })
      } as any;

      const tools: ToolDefinition[] = [
        { name: 'list_users', description: 'List', parameters: {}, operations: { list: 'listOp' } },
        { name: 'get_user', description: 'Get', parameters: {}, operations: { read: 'getOp' } },
        { name: 'manage_items', description: 'Manage', parameters: {}, operations: { list: 'listOp', read: 'getOp' } },
        { name: 'delete_user', description: 'Delete', parameters: {}, operations: { delete: 'deleteOp' } }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(['list', 'read']),
        hasAllowRules: true,
        sources: { allowList: [], allowRegex: [], denyList: [], denyRegex: [], allowCategories: ['list', 'read'] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any, mockDetector);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(3);
      expect(result.allowed.map(t => t.name)).toContain('list_users');
      expect(result.allowed.map(t => t.name)).toContain('get_user');
      expect(result.allowed.map(t => t.name)).toContain('manage_items');
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].name).toBe('delete_user');
    });

    it('OR semantics: allows tool by name even if category does not match', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn(() => ({ isList: false, isRead: false }))
      } as any;

      const tools: ToolDefinition[] = [
        { name: 'delete_user', description: 'Delete (allowed by name)', parameters: {}, operations: { delete: 'deleteOp' } }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(['delete_user']),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(['list', 'read']),
        hasAllowRules: true,
        sources: { allowList: ['delete_user'], allowRegex: [], denyList: [], denyRegex: [], allowCategories: ['list', 'read'] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any, mockDetector);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(1);
      expect(result.allowed[0].name).toBe('delete_user');
    });

    it('deny takes precedence over category allow', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn(() => ({ isList: true, isRead: false }))
      } as any;

      const tools: ToolDefinition[] = [
        { name: 'list_admin', description: 'List admin', parameters: {}, operations: { list: 'listAdminOp' } }
      ];

      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(['list_admin']),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(['list']),
        hasAllowRules: true,
        sources: { allowList: [], allowRegex: [], denyList: ['list_admin'], denyRegex: [], allowCategories: ['list'] }
      };

      const filter = new GlobalToolFilter(config, mockLogger as any, mockDetector);
      const result = filter.apply(tools);

      expect(result.allowed).toHaveLength(0);
      expect(result.removed).toHaveLength(1);
      expect(result.reasons.get('list_admin')).toContain('deny_list');
    });

    it('throws error when allowCategories set but no detector provided', () => {
      const config: ToolFilterConfig = {
        allowList: new Set(),
        denyList: new Set(),
        allowRegex: [],
        denyRegex: [],
        allowCategories: new Set(['list', 'read']),
        hasAllowRules: true,
        sources: { allowList: [], allowRegex: [], denyList: [], denyRegex: [], allowCategories: ['list', 'read'] }
      };

      expect(() => {
        new GlobalToolFilter(config, mockLogger as any);
      }).toThrow(/OperationDetector is not available/);
    });

    it('works without detector when no categories configured', () => {
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} }
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
    });
  });
});
