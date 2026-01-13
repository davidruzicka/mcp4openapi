import { describe, it, expect, vi } from 'vitest';
import { CategoryMatchRule } from './filter-rules.js';
import { OperationDetector } from '../operation/operation-detector.js';
import { OperationClassifier } from '../operation/operation-classifier.js';
import type { OperationResolver } from '../types.js';
import type { ToolDefinition } from '../../types/profile.js';

describe('CategoryMatchRule', () => {
  const classifier = new OperationClassifier();
  const mockResolver: OperationResolver = {
    getOperationById: vi.fn(),
    getOperationForCall: vi.fn()
  };
  const detector = new OperationDetector(classifier, mockResolver);

  describe('list-only category', () => {
    it('matches list-only tools', () => {
      const rule = new CategoryMatchRule(new Set(['list']), detector);
      
      const listTool: ToolDefinition = {
        name: 'list_users',
        description: 'List',
        parameters: {},
        operations: { list: 'listOp' }
      };

      // Mock detector to return list-only
      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: true, isRead: false });
      
      expect(rule.matches(listTool)).toBe(true);
    });

    it('rejects read-only tools', () => {
      const rule = new CategoryMatchRule(new Set(['list']), detector);
      
      const readTool: ToolDefinition = {
        name: 'get_user',
        description: 'Get',
        parameters: {},
        operations: { read: 'getOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: false, isRead: true });
      
      expect(rule.matches(readTool)).toBe(false);
    });

    it('rejects mixed tools', () => {
      const rule = new CategoryMatchRule(new Set(['list']), detector);
      
      const mixedTool: ToolDefinition = {
        name: 'manage',
        description: 'Manage',
        parameters: {},
        operations: { list: 'listOp', read: 'getOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: true, isRead: true });
      
      expect(rule.matches(mixedTool)).toBe(false);
    });
  });

  describe('read-only category', () => {
    it('matches read-only tools', () => {
      const rule = new CategoryMatchRule(new Set(['read']), detector);
      
      const readTool: ToolDefinition = {
        name: 'get_user',
        description: 'Get',
        parameters: {},
        operations: { read: 'getOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: false, isRead: true });
      
      expect(rule.matches(readTool)).toBe(true);
    });

    it('rejects list-only tools', () => {
      const rule = new CategoryMatchRule(new Set(['read']), detector);
      
      const listTool: ToolDefinition = {
        name: 'list_users',
        description: 'List',
        parameters: {},
        operations: { list: 'listOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: true, isRead: false });
      
      expect(rule.matches(listTool)).toBe(false);
    });
  });

  describe('list+read categories', () => {
    it('matches list-only tools', () => {
      const rule = new CategoryMatchRule(new Set(['list', 'read']), detector);
      
      const listTool: ToolDefinition = {
        name: 'list_users',
        description: 'List',
        parameters: {},
        operations: { list: 'listOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: true, isRead: false });
      
      expect(rule.matches(listTool)).toBe(true);
    });

    it('matches read-only tools', () => {
      const rule = new CategoryMatchRule(new Set(['list', 'read']), detector);
      
      const readTool: ToolDefinition = {
        name: 'get_user',
        description: 'Get',
        parameters: {},
        operations: { read: 'getOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: false, isRead: true });
      
      expect(rule.matches(readTool)).toBe(true);
    });

    it('matches mixed list+read tools', () => {
      const rule = new CategoryMatchRule(new Set(['list', 'read']), detector);
      
      const mixedTool: ToolDefinition = {
        name: 'manage',
        description: 'Manage',
        parameters: {},
        operations: { list: 'listOp', read: 'getOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: true, isRead: true });
      
      expect(rule.matches(mixedTool)).toBe(true);
    });

    it('rejects modify tools', () => {
      const rule = new CategoryMatchRule(new Set(['list', 'read']), detector);
      
      const modifyTool: ToolDefinition = {
        name: 'delete_user',
        description: 'Delete',
        parameters: {},
        operations: { delete: 'deleteOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: false, isRead: false });
      
      expect(rule.matches(modifyTool)).toBe(false);
    });
  });

  describe('getReason', () => {
    it('returns categories in sorted order', () => {
      const rule = new CategoryMatchRule(new Set(['read', 'list']), detector);
      expect(rule.getReason()).toBe('allow_categories:list,read');
    });

    it('returns single category', () => {
      const rule = new CategoryMatchRule(new Set(['list']), detector);
      expect(rule.getReason()).toBe('allow_categories:list');
    });
  });

  describe('string input handling', () => {
    it('returns false when passed string instead of ToolDefinition', () => {
      const rule = new CategoryMatchRule(new Set(['list']), detector);
      expect(rule.matches('list_users')).toBe(false);
    });
  });

  describe('empty allowedCategories', () => {
    it('returns false when no categories allowed', () => {
      const rule = new CategoryMatchRule(new Set(), detector);
      
      const tool: ToolDefinition = {
        name: 'get_user',
        description: 'Get',
        parameters: {},
        operations: { read: 'getOp' }
      };

      vi.spyOn(detector, 'detectCategories').mockReturnValue({ isList: false, isRead: true });
      
      expect(rule.matches(tool)).toBe(false);
    });
  });
});
