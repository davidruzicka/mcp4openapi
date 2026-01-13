import { describe, it, expect, vi } from 'vitest';
import { SessionToolFilter } from './session-tool-filter.js';
import type { SessionToolFilterRequest } from '../types.js';
import type { ToolDefinition } from '../../types/profile.js';
import { OperationClassifier } from '../operation/operation-classifier.js';
import { OperationDetector } from '../operation/operation-detector.js';
import type { OperationResolver } from '../types.js';
import type { OperationInfo } from '../../types/openapi.js';

describe('SessionToolFilter', () => {
  const createTool = (name: string): ToolDefinition => ({
    name,
    description: `Tool ${name}`,
    parameters: {}
  });

  describe('basic filtering', () => {
    it('allows all tools when request has no rules', () => {
      const request: SessionToolFilterRequest = {
        exactNames: new Set(),
        regexPatterns: [],
        allowCategories: new Set(),
        normalizedHeader: '',
        rawEntries: [],
        hasRules: false
      };

      const filter = new SessionToolFilter(request);
      const tools = [createTool('get_user'), createTool('delete_user')];
      const result = filter.apply(tools);

      expect(result.allowedToolNames.size).toBe(2);
      expect(result.allowedToolNames.has('get_user')).toBe(true);
      expect(result.allowedToolNames.has('delete_user')).toBe(true);
    });

    it('filters by exact names', () => {
      const request: SessionToolFilterRequest = {
        exactNames: new Set(['get_user']),
        regexPatterns: [],
        allowCategories: new Set(),
        normalizedHeader: 'get_user',
        rawEntries: ['get_user'],
        hasRules: true
      };

      const filter = new SessionToolFilter(request);
      const tools = [createTool('get_user'), createTool('delete_user')];
      const result = filter.apply(tools);

      expect(result.allowedToolNames.size).toBe(1);
      expect(result.allowedToolNames.has('get_user')).toBe(true);
      expect(result.reasons.has('delete_user')).toBe(true);
    });
  });

  describe('category filtering', () => {
    it('throws when allowCategories requested but no detector provided', () => {
      const request: SessionToolFilterRequest = {
        exactNames: new Set(),
        regexPatterns: [],
        allowCategories: new Set(['list']),
        normalizedHeader: '_allow_list',
        rawEntries: ['_allow_list'],
        hasRules: true
      };

      // No detector provided
      expect(() => new SessionToolFilter(request)).toThrow(
        /OperationDetector is not available/
      );
    });

    it('filters by list category when detector provided', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn((id) => {
          if (id === 'listUsers') {
            return {
              operationId: 'listUsers',
              method: 'get',
              path: '/users',
              parameters: []
            } as OperationInfo;
          }
          if (id === 'deleteUser') {
            return {
              operationId: 'deleteUser',
              method: 'delete',
              path: '/users/{id}',
              parameters: [{ in: 'path', name: 'id', required: true }]
            } as OperationInfo;
          }
          return undefined;
        }),
        getOperationForCall: vi.fn()
      };

      const classifier = new OperationClassifier();
      const detector = new OperationDetector(classifier, resolver);

      const request: SessionToolFilterRequest = {
        exactNames: new Set(),
        regexPatterns: [],
        allowCategories: new Set(['list']),
        normalizedHeader: '_allow_list',
        rawEntries: ['_allow_list'],
        hasRules: true
      };

      const filter = new SessionToolFilter(request, detector);
      const tools: ToolDefinition[] = [
        {
          name: 'list_users',
          description: 'List',
          parameters: {},
          operations: { list: 'listUsers' }
        },
        {
          name: 'delete_user',
          description: 'Delete',
          parameters: {},
          operations: { delete: 'deleteUser' }
        }
      ];

      const result = filter.apply(tools);

      expect(result.allowedToolNames.has('list_users')).toBe(true);
      expect(result.allowedToolNames.has('delete_user')).toBe(false);
    });

    it('filters by read category', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn((id) => {
          if (id === 'getUser') {
            return {
              operationId: 'getUser',
              method: 'get',
              path: '/users/{id}',
              parameters: [{ in: 'path', name: 'id', required: true }]
            } as OperationInfo;
          }
          return undefined;
        }),
        getOperationForCall: vi.fn()
      };

      const classifier = new OperationClassifier();
      const detector = new OperationDetector(classifier, resolver);

      const request: SessionToolFilterRequest = {
        exactNames: new Set(),
        regexPatterns: [],
        allowCategories: new Set(['read']),
        normalizedHeader: '_allow_read',
        rawEntries: ['_allow_read'],
        hasRules: true
      };

      const filter = new SessionToolFilter(request, detector);
      const tools: ToolDefinition[] = [
        {
          name: 'get_user',
          description: 'Get',
          parameters: {},
          operations: { read: 'getUser' }
        },
        {
          name: 'list_users',
          description: 'List',
          parameters: {},
          operations: { list: 'listUsers' }
        }
      ];

      const result = filter.apply(tools);

      expect(result.allowedToolNames.has('get_user')).toBe(true);
      expect(result.allowedToolNames.has('list_users')).toBe(false);
    });

    it('combines categories with exact names (OR semantics)', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn((id) => {
          if (id === 'listUsers') {
            return {
              operationId: 'listUsers',
              method: 'get',
              path: '/users',
              parameters: []
            } as OperationInfo;
          }
          if (id === 'deleteUser') {
            return {
              operationId: 'deleteUser',
              method: 'delete',
              path: '/users/{id}',
              parameters: [{ in: 'path', name: 'id', required: true }]
            } as OperationInfo;
          }
          if (id === 'updateUser') {
            return {
              operationId: 'updateUser',
              method: 'put',
              path: '/users/{id}',
              parameters: [{ in: 'path', name: 'id', required: true }]
            } as OperationInfo;
          }
          return undefined;
        }),
        getOperationForCall: vi.fn()
      };

      const classifier = new OperationClassifier();
      const detector = new OperationDetector(classifier, resolver);

      const request: SessionToolFilterRequest = {
        exactNames: new Set(['delete_user']),
        regexPatterns: [],
        allowCategories: new Set(['list']),
        normalizedHeader: '_allow_list,delete_user',
        rawEntries: ['_allow_list', 'delete_user'],
        hasRules: true
      };

      const filter = new SessionToolFilter(request, detector);
      const tools: ToolDefinition[] = [
        {
          name: 'list_users',
          description: 'List',
          parameters: {},
          operations: { list: 'listUsers' }
        },
        {
          name: 'delete_user',
          description: 'Delete',
          parameters: {},
          operations: { delete: 'deleteUser' }
        },
        {
          name: 'update_user',
          description: 'Update',
          parameters: {},
          operations: { update: 'updateUser' }
        }
      ];

      const result = filter.apply(tools);

      // list_users: matches category
      expect(result.allowedToolNames.has('list_users')).toBe(true);
      // delete_user: matches exact name
      expect(result.allowedToolNames.has('delete_user')).toBe(true);
      // update_user: no match
      expect(result.allowedToolNames.has('update_user')).toBe(false);
    });
  });
});
