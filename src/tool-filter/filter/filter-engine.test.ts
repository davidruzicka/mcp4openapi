import { describe, it, expect, vi } from 'vitest';
import { FilterEngine, FilterResult } from './filter-engine.js';
import { ExactMatchRule, RegexMatchRule, CategoryMatchRule } from './filter-rules.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';
import type { ToolDefinition } from '../../types/profile.js';
import type { OperationDetector } from '../operation/operation-detector.js';

describe('FilterEngine', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);

  describe('no rules (allow all)', () => {
    it('allows all tools when no rules defined', () => {
      const engine = new FilterEngine([], []);
      const result = engine.evaluate('any_tool');
      
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('deny rules precedence', () => {
    it('denies tools matching deny list even if in allow list', () => {
      const allowRule = new ExactMatchRule(new Set(['get_user', 'delete_user']), 'allow');
      const denyRule = new ExactMatchRule(new Set(['delete_user']), 'deny');
      
      const engine = new FilterEngine([allowRule], [denyRule]);
      
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('delete_user').allowed).toBe(false);
      expect(engine.evaluate('delete_user').reason).toBe('deny_list');
    });

    it('checks deny rules before allow rules', () => {
      const allowPattern = compiler.compile('.*_user', 'test');
      const denyPattern = compiler.compile('delete_.*', 'test');
      
      const allowRule = new RegexMatchRule([allowPattern], 'allow');
      const denyRule = new RegexMatchRule([denyPattern], 'deny');
      
      const engine = new FilterEngine([allowRule], [denyRule]);
      
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('delete_user').allowed).toBe(false);
    });
  });

  describe('allow rules', () => {
    it('rejects tools not matching allow rules', () => {
      const allowRule = new ExactMatchRule(new Set(['get_user', 'list_users']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('list_users').allowed).toBe(true);
      expect(engine.evaluate('delete_user').allowed).toBe(false);
    });

    it('accepts if any allow rule matches', () => {
      const exactRule = new ExactMatchRule(new Set(['exact_match']), 'allow');
      const patternRule = new RegexMatchRule([compiler.compile('pattern_.*', 'test')], 'allow');
      
      const engine = new FilterEngine([exactRule, patternRule], []);
      
      expect(engine.evaluate('exact_match').allowed).toBe(true);
      expect(engine.evaluate('pattern_foo').allowed).toBe(true);
      expect(engine.evaluate('other').allowed).toBe(false);
    });

    it('returns reason when denied by allow rules', () => {
      const allowRule = new ExactMatchRule(new Set(['allowed']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      const result = engine.evaluate('denied');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('no_allow_match');
    });
  });

  describe('tool name normalization', () => {
    it('normalizes tool names before matching', () => {
      // Unicode composition: café vs cafe\u0301
      const allowRule = new ExactMatchRule(new Set(['café']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      expect(engine.evaluate('cafe\u0301').allowed).toBe(true);
    });
  });

  describe('FilterResult', () => {
    it('creates allowed result', () => {
      const result = FilterResult.allowed('test_reason');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('test_reason');
    });

    it('creates allowed result without reason', () => {
      const result = FilterResult.allowed();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('creates denied result', () => {
      const result = FilterResult.denied('deny_reason');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('deny_reason');
    });
  });

  describe('complex scenarios', () => {
    it('handles multiple allow and deny rules', () => {
      const allowExact = new ExactMatchRule(new Set(['get_user', 'list_users']), 'allow');
      const allowPattern = new RegexMatchRule([compiler.compile('read_.*', 'test')], 'allow');
      const denyExact = new ExactMatchRule(new Set(['read_secret']), 'deny');
      const denyPattern = new RegexMatchRule([compiler.compile('.*_admin', 'test')], 'deny');
      
      const engine = new FilterEngine([allowExact, allowPattern], [denyExact, denyPattern]);
      
      // Allowed by exact
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('list_users').allowed).toBe(true);
      
      // Allowed by pattern
      expect(engine.evaluate('read_item').allowed).toBe(true);
      
      // Denied by exact
      expect(engine.evaluate('read_secret').allowed).toBe(false);
      
      // Denied by pattern
      expect(engine.evaluate('get_admin').allowed).toBe(false);
      expect(engine.evaluate('list_admin').allowed).toBe(false);
      
      // Not in allow list
      expect(engine.evaluate('delete_user').allowed).toBe(false);
    });

    it('stores reason from matching rule', () => {
      const allowRule = new ExactMatchRule(new Set(['allowed']), 'allow');
      const denyRule = new RegexMatchRule([compiler.compile('deny_.*', 'test')], 'deny');
      
      const engine = new FilterEngine([allowRule], [denyRule]);
      
      expect(engine.evaluate('allowed').reason).toBe('allow_list');
      expect(engine.evaluate('deny_something').reason).toBe('deny_regex');
      expect(engine.evaluate('other').reason).toBe('no_allow_match');
    });
  });

  describe('evaluateTool() method', () => {
    it('allows all tools when no rules defined', () => {
      const engine = new FilterEngine([], []);
      const tool: ToolDefinition = {
        name: 'any_tool',
        description: 'Any tool',
        parameters: {}
      };
      
      const result = engine.evaluateTool(tool);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('works with ExactMatchRule using ToolDefinition', () => {
      const allowRule = new ExactMatchRule(new Set(['get_user', 'list_users']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      const allowed: ToolDefinition = {
        name: 'get_user',
        description: 'Get',
        parameters: {}
      };
      
      const denied: ToolDefinition = {
        name: 'delete_user',
        description: 'Delete',
        parameters: {}
      };
      
      expect(engine.evaluateTool(allowed).allowed).toBe(true);
      expect(engine.evaluateTool(denied).allowed).toBe(false);
    });

    it('works with RegexMatchRule using ToolDefinition', () => {
      const pattern = compiler.compile('get_.*', 'test');
      const allowRule = new RegexMatchRule([pattern], 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      const matched: ToolDefinition = {
        name: 'get_user',
        description: 'Get',
        parameters: {}
      };
      
      const notMatched: ToolDefinition = {
        name: 'list_user',
        description: 'List',
        parameters: {}
      };
      
      expect(engine.evaluateTool(matched).allowed).toBe(true);
      expect(engine.evaluateTool(notMatched).allowed).toBe(false);
    });

    it('normalizes tool names before matching (NFC)', () => {
      const allowRule = new ExactMatchRule(new Set(['café']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      const tool: ToolDefinition = {
        name: 'cafe\u0301', // decomposed form
        description: 'Test',
        parameters: {}
      };
      
      expect(engine.evaluateTool(tool).allowed).toBe(true);
    });

    it('works with CategoryMatchRule for list-only tools', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn().mockReturnValue({ isList: true, isRead: false })
      } as any;
      
      const categoryRule = new CategoryMatchRule(new Set(['list']), mockDetector);
      const engine = new FilterEngine([categoryRule], []);
      
      const listTool: ToolDefinition = {
        name: 'list_users',
        description: 'List',
        parameters: {},
        operations: { list: 'listOp' }
      };
      
      expect(engine.evaluateTool(listTool).allowed).toBe(true);
      expect(mockDetector.detectCategories).toHaveBeenCalledWith(listTool);
    });

    it('works with CategoryMatchRule for read-only tools', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn().mockReturnValue({ isList: false, isRead: true })
      } as any;
      
      const categoryRule = new CategoryMatchRule(new Set(['read']), mockDetector);
      const engine = new FilterEngine([categoryRule], []);
      
      const readTool: ToolDefinition = {
        name: 'get_user',
        description: 'Get',
        parameters: {},
        operations: { read: 'getOp' }
      };
      
      expect(engine.evaluateTool(readTool).allowed).toBe(true);
    });

    it('denies modify tools when only list,read categories allowed', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn().mockReturnValue({ isList: false, isRead: false })
      } as any;
      
      const categoryRule = new CategoryMatchRule(new Set(['list', 'read']), mockDetector);
      const engine = new FilterEngine([categoryRule], []);
      
      const modifyTool: ToolDefinition = {
        name: 'delete_user',
        description: 'Delete',
        parameters: {},
        operations: { delete: 'deleteOp' }
      };
      
      expect(engine.evaluateTool(modifyTool).allowed).toBe(false);
      expect(engine.evaluateTool(modifyTool).reason).toBe('no_allow_match');
    });

    it('OR semantics: allows tool matching exact name OR category', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn().mockReturnValue({ isList: false, isRead: false })
      } as any;
      
      const exactRule = new ExactMatchRule(new Set(['delete_user']), 'allow');
      const categoryRule = new CategoryMatchRule(new Set(['list', 'read']), mockDetector);
      const engine = new FilterEngine([exactRule, categoryRule], []);
      
      const modifyTool: ToolDefinition = {
        name: 'delete_user',
        description: 'Delete (allowed by name)',
        parameters: {},
        operations: { delete: 'deleteOp' }
      };
      
      // Should be allowed because of exactRule, even though category doesn't match
      expect(engine.evaluateTool(modifyTool).allowed).toBe(true);
      expect(engine.evaluateTool(modifyTool).reason).toBe('allow_list');
    });

    it('deny rules take precedence over category allow rules', () => {
      const mockDetector: OperationDetector = {
        detectCategories: vi.fn().mockReturnValue({ isList: true, isRead: false })
      } as any;
      
      const categoryRule = new CategoryMatchRule(new Set(['list']), mockDetector);
      const denyRule = new ExactMatchRule(new Set(['list_admin']), 'deny');
      const engine = new FilterEngine([categoryRule], [denyRule]);
      
      const adminListTool: ToolDefinition = {
        name: 'list_admin',
        description: 'List admins',
        parameters: {},
        operations: { list: 'listAdminOp' }
      };
      
      // Should be denied because deny takes precedence
      expect(engine.evaluateTool(adminListTool).allowed).toBe(false);
      expect(engine.evaluateTool(adminListTool).reason).toBe('deny_list');
    });

    it('backward compatibility: evaluate() still works with string', () => {
      const allowRule = new ExactMatchRule(new Set(['allowed']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      expect(engine.evaluate('allowed').allowed).toBe(true);
      expect(engine.evaluate('denied').allowed).toBe(false);
    });
  });
});
