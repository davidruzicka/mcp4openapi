import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ToolDefinition } from './types/profile.js';
import type { OperationInfo } from './types/openapi.js';
import { AuthorizationError, ValidationError } from './errors.js';
import { enforceFiltering, parseFilteringHeader } from './filtering.js';

describe('filtering', () => {
  const baseTool: ToolDefinition = {
    name: 'projects',
    description: 'Project operations',
    operations: {
      list: 'listProjects',
      get: 'getProject',
      update: 'updateProject',
    },
    parameters: {
      action: {
        type: 'string',
        description: 'Action',
        enum: ['list', 'get', 'update'],
      },
      project_id: {
        type: 'string',
        description: 'Project ID',
      },
    },
  };

  const listOperation: OperationInfo = {
    operationId: 'listProjects',
    method: 'get',
    path: '/projects',
    parameters: [],
  };

  const readOperation: OperationInfo = {
    operationId: 'getProject',
    method: 'get',
    path: '/projects/{id}',
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ],
  };

  describe('parseFilteringHeader', () => {
    const originalMax = process.env.MCP4_FILTER_MAX_VALUES;

    afterEach(() => {
      if (originalMax === undefined) {
        delete process.env.MCP4_FILTER_MAX_VALUES;
      } else {
        process.env.MCP4_FILTER_MAX_VALUES = originalMax;
      }
    });

    it('parses values and control keys', () => {
      const result = parseFilteringHeader('resource_id=123, resource_id=456, _allow_list');
      const filtering = Object.fromEntries(Object.entries(result.filtering));

      expect(filtering).toEqual({
        resource_id: ['123', '456'],
        _allow_list: [],
      });
    });

    it('decodes values and ignores empty entries', () => {
      const result = parseFilteringHeader('project_path=foo%2Fbar, resource_id=');
      const filtering = Object.fromEntries(Object.entries(result.filtering));

      expect(filtering).toEqual({
        project_path: ['foo/bar'],
      });
    });

    it('rejects invalid items', () => {
      expect(() => parseFilteringHeader('resource_id')).toThrow(ValidationError);
    });

    it('enforces max values per key', () => {
      process.env.MCP4_FILTER_MAX_VALUES = '2';
      expect(() => parseFilteringHeader('resource_id=1, resource_id=2, resource_id=3')).toThrow(
        ValidationError
      );
    });
  });

  describe('enforceFiltering', () => {
    it('requires filter params for list without allow flag', () => {
      const filtering = { project_id: ['123'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'list' },
          operation: listOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('allows list when _allow_list is present', () => {
      const filtering = { project_id: ['123'], _allow_list: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'list' },
          operation: listOperation,
        })
      ).not.toThrow();
    });

    it('requires filter params for read without allow flag', () => {
      const filtering = { project_id: ['123'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get' },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('allows read when _allow_read is present', () => {
      const filtering = { project_id: ['123'], _allow_read: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get' },
          operation: readOperation,
        })
      ).not.toThrow();
    });

    it('requires at least one filter param for modify actions', () => {
      const filtering = { project_id: ['123'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'update' },
          operation: undefined,
        })
      ).toThrow(AuthorizationError);
    });

    it('rejects values outside the allowed set', () => {
      const filtering = { project_id: ['123'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: '999' },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('validates array arguments against the allowed set', () => {
      const filtering = { project_id: ['1', '2'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: ['1', '2'] },
          operation: readOperation,
        })
      ).not.toThrow();

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: ['1', '3'] },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('rejects object values', () => {
      const filtering = { project_id: ['1'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: { id: '1' } },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('supports alias keys for filtering', () => {
      const filtering = { id: ['123'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: '123' },
          parameterAliases: { project_id: ['id'] },
          operation: readOperation,
        })
      ).not.toThrow();
    });

    it('ignores filter keys not present in tool parameters', () => {
      const filtering = { merge_request_iid: ['8'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'update' },
          operation: undefined,
        })
      ).not.toThrow();
    });
  });
});
