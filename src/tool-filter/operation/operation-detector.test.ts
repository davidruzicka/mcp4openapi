import { describe, it, expect, vi } from 'vitest';
import { OperationDetector } from './operation-detector.js';
import { OperationClassifier } from './operation-classifier.js';
import type { OperationResolver } from '../types.js';
import type { ToolDefinition } from '../../types/profile.js';
import type { OperationInfo } from '../../types/openapi.js';

describe('OperationDetector', () => {
  const classifier = new OperationClassifier();

  describe('simple tools (operations field)', () => {
    it('detects list operations from operation key', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn().mockReturnValue({
          operationId: 'listUsers',
          method: 'get',
          path: '/users',
          parameters: []
        } as OperationInfo),
        getOperationForCall: vi.fn()
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'list_users',
        description: 'List users',
        parameters: {},
        operations: { list: 'listUsers' }
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(true);
      expect(result.isRead).toBe(false);
    });

    it('detects read operations from operation key', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn().mockReturnValue({
          operationId: 'getUser',
          method: 'get',
          path: '/users/{id}',
          parameters: [{ in: 'path', name: 'id', required: true }]
        } as OperationInfo),
        getOperationForCall: vi.fn()
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'get_user',
        description: 'Get user',
        parameters: {},
        operations: { read: 'getUser' }
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(true);
    });

    it('detects both list and read when tool has both', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn((id) => {
          if (id === 'listUsers') {
            return { operationId: 'listUsers', method: 'get', path: '/users', parameters: [] };
          }
          if (id === 'getUser') {
            return { operationId: 'getUser', method: 'get', path: '/users/{id}', parameters: [{ in: 'path', name: 'id' }] };
          }
          return undefined;
        }),
        getOperationForCall: vi.fn()
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'manage_users',
        description: 'Manage users',
        parameters: {},
        operations: { list: 'listUsers', read: 'getUser' }
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(true);
      expect(result.isRead).toBe(true);
    });

    it('falls back to action name detection when resolver returns undefined', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn().mockReturnValue(undefined),
        getOperationForCall: vi.fn()
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'tool',
        description: 'Tool',
        parameters: {},
        operations: { list: 'unknownOp', get: 'unknownOp2' }
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(true); // from 'list' key
      expect(result.isRead).toBe(true);  // from 'get' key
    });

    it('ignores modify operations', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn().mockReturnValue({
          operationId: 'createUser',
          method: 'post',
          path: '/users',
          parameters: []
        } as OperationInfo),
        getOperationForCall: vi.fn()
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'create_user',
        description: 'Create user',
        parameters: {},
        operations: { create: 'createUser' }
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(false);
    });
  });

  describe('composite tools', () => {
    it('detects all-list composite', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn(),
        getOperationForCall: vi.fn((call) => {
          if (call === 'GET /users') {
            return { operationId: 'listUsers', method: 'get', path: '/users', parameters: [] } as OperationInfo;
          }
          if (call === 'GET /projects') {
            return { operationId: 'listProjects', method: 'get', path: '/projects', parameters: [] } as OperationInfo;
          }
          return undefined;
        })
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'list_all',
        description: 'List all',
        composite: true,
        steps: [
          { call: 'GET /users', store_as: 'users' },
          { call: 'GET /projects', store_as: 'projects' }
        ],
        parameters: {}
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(true);
      expect(result.isRead).toBe(false);
    });

    it('detects all-read composite', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn(),
        getOperationForCall: vi.fn((call) => {
          if (call === 'GET /users/{id}') {
            return {
              operationId: 'getUser',
              method: 'get',
              path: '/users/{id}',
              parameters: [{ in: 'path', name: 'id' }]
            } as OperationInfo;
          }
          if (call === 'GET /projects/{id}') {
            return {
              operationId: 'getProject',
              method: 'get',
              path: '/projects/{id}',
              parameters: [{ in: 'path', name: 'id' }]
            } as OperationInfo;
          }
          return undefined;
        })
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'read_details',
        description: 'Read details',
        composite: true,
        steps: [
          { call: 'GET /users/{id}', store_as: 'user' },
          { call: 'GET /projects/{id}', store_as: 'project' }
        ],
        parameters: {}
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(true);
    });

    it('rejects mixed list+read composite', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn(),
        getOperationForCall: vi.fn((call) => {
          if (call === 'GET /users') {
            return { operationId: 'listUsers', method: 'get', path: '/users', parameters: [] } as OperationInfo;
          }
          if (call === 'GET /users/{id}') {
            return {
              operationId: 'getUser',
              method: 'get',
              path: '/users/{id}',
              parameters: [{ in: 'path', name: 'id' }]
            } as OperationInfo;
          }
          return undefined;
        })
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'mixed_tool',
        description: 'Mixed',
        composite: true,
        steps: [
          { call: 'GET /users', store_as: 'users' },
          { call: 'GET /users/{id}', store_as: 'user' }
        ],
        parameters: {}
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(false);
    });

    it('rejects composite with modify operation', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn(),
        getOperationForCall: vi.fn((call) => {
          if (call === 'GET /users') {
            return { operationId: 'listUsers', method: 'get', path: '/users', parameters: [] } as OperationInfo;
          }
          if (call === 'POST /users') {
            return { operationId: 'createUser', method: 'post', path: '/users', parameters: [] } as OperationInfo;
          }
          return undefined;
        })
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'bad_composite',
        description: 'Bad',
        composite: true,
        steps: [
          { call: 'GET /users', store_as: 'users' },
          { call: 'POST /users', store_as: 'created' }
        ],
        parameters: {}
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(false);
    });

    it('handles unresolvable steps', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn(),
        getOperationForCall: vi.fn().mockReturnValue(undefined)
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'broken',
        description: 'Broken',
        composite: true,
        steps: [{ call: 'GET /unknown', store_as: 'x' }],
        parameters: {}
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(false);
    });
  });

  describe('tools without operations or composite', () => {
    it('returns false for both categories', () => {
      const resolver: OperationResolver = {
        getOperationById: vi.fn(),
        getOperationForCall: vi.fn()
      };

      const detector = new OperationDetector(classifier, resolver);
      const tool: ToolDefinition = {
        name: 'unknown',
        description: 'Unknown',
        parameters: {}
      };

      const result = detector.detectCategories(tool);
      expect(result.isList).toBe(false);
      expect(result.isRead).toBe(false);
    });
  });
});
