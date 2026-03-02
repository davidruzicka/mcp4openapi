import { describe, it, expect, afterEach } from 'vitest';
import type { ToolDefinition } from '../types/profile.js';
import type { OperationInfo } from '../types/openapi.js';
import { AuthorizationError, ValidationError } from './errors.js';
import {
  enforceFiltering,
  getFilterMaxValues,
  isFilteringKeySupported,
  mergeFilteringRules,
  normalizeFilteringHeaderValue,
  parseConfiguredFilteringValue,
  parseFilteringHeader,
} from './filtering.js';

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

    it('rejects invalid key patterns', () => {
      expect(() => parseFilteringHeader('bad key=1')).toThrow(ValidationError);
      expect(() => parseFilteringHeader('-bad=1')).toThrow(ValidationError);
    });

    it('rejects control keys with values', () => {
      expect(() => parseFilteringHeader('_allow_list=1')).toThrow(ValidationError);
      expect(() => parseFilteringHeader('_allow_read=1')).toThrow(ValidationError);
    });

    it('rejects malformed percent-encoding', () => {
      expect(() => parseFilteringHeader('project_id=%E0%A4%A')).toThrow(ValidationError);
    });

    it('enforces max values per key', () => {
      process.env.MCP4_FILTER_MAX_VALUES = '2';
      expect(() => parseFilteringHeader('resource_id=1, resource_id=2, resource_id=3')).toThrow(
        ValidationError
      );
    });

    it('returns empty filtering for blank header', () => {
      const result = parseFilteringHeader('   ');
      expect(Object.keys(result.filtering)).toHaveLength(0);
      expect(result.normalizedHeader).toBe('');
    });

    it('ignores empty parts between commas', () => {
      const result = parseFilteringHeader('resource_id=1,,project_id=2');
      expect(result.filtering.resource_id).toEqual(['1']);
      expect(result.filtering.project_id).toEqual(['2']);
    });
  });

  describe('normalizeFilteringHeaderValue', () => {
    it('returns undefined for empty or whitespace values', () => {
      expect(normalizeFilteringHeaderValue('')).toBeUndefined();
      expect(normalizeFilteringHeaderValue('   ')).toBeUndefined();
    });

    it('returns undefined for null or undefined', () => {
      expect(normalizeFilteringHeaderValue(undefined)).toBeUndefined();
      expect(normalizeFilteringHeaderValue(null as any)).toBeUndefined();
    });

    it('trims non-empty values', () => {
      expect(normalizeFilteringHeaderValue('  resource_id=1 ')).toBe('resource_id=1');
    });
  });

  describe('parseConfiguredFilteringValue', () => {
    it('returns empty filtering for unset or blank config', () => {
      expect(parseConfiguredFilteringValue(undefined)).toEqual({
        filtering: {},
        normalizedHeader: '',
      });
      expect(parseConfiguredFilteringValue('   ')).toEqual({
        filtering: {},
        normalizedHeader: '',
      });
    });

    it('parses valid config using the same rules as X-Mcp4-Params', () => {
      expect(parseConfiguredFilteringValue('project_id=123,_allow_read')).toEqual({
        filtering: {
          project_id: ['123'],
          _allow_read: [],
        },
        normalizedHeader: 'project_id=123,_allow_read',
      });
    });
  });

  describe('isFilteringKeySupported', () => {
    it('accepts only header-safe filter keys', () => {
      expect(isFilteringKeySupported('project_id')).toBe(true);
      expect(isFilteringKeySupported('project-id')).toBe(true);
      expect(isFilteringKeySupported('managed_scan_config.diff_scan.enabled')).toBe(false);
      expect(isFilteringKeySupported('-project_id')).toBe(false);
      expect(isFilteringKeySupported('bad key')).toBe(false);
    });
  });

  describe('mergeFilteringRules', () => {
    it('returns undefined when both filtering scopes are empty', () => {
      expect(mergeFilteringRules()).toBeUndefined();
      expect(mergeFilteringRules({}, {})).toBeUndefined();
    });

    it('returns a cloned single filtering scope unchanged', () => {
      const baseFiltering = { project_id: ['1'], _allow_read: [] };
      const merged = mergeFilteringRules(baseFiltering, undefined);
      expect(merged).toEqual(baseFiltering);
      expect(merged).not.toBeUndefined();
      expect(merged).not.toBe(baseFiltering);
    });

    it('intersects overlapping values and retains unique keys', () => {
      const merged = mergeFilteringRules(
        { project_id: ['1', '2'], group_id: ['9'], _allow_read: [] },
        { project_id: ['2', '3'], issue_id: ['7'], _allow_read: [], _allow_list: [] }
      );

      expect(merged).toEqual({
        project_id: ['2'],
        group_id: ['9'],
        issue_id: ['7'],
        _allow_read: [],
      });
    });

    it('rejects conflicting overlapping values', () => {
      expect(() =>
        mergeFilteringRules({ project_id: ['1'] }, { project_id: ['2'] })
      ).toThrow(ValidationError);
    });

    it('retains control keys only when both scopes allow them', () => {
      const merged = mergeFilteringRules(
        { project_id: ['1'], _allow_read: [] },
        { group_id: ['2'], _allow_list: [] }
      );

      expect(merged).toEqual({
        project_id: ['1'],
        group_id: ['2'],
      });
    });
  });

  describe('getFilterMaxValues', () => {
    const originalMax = process.env.MCP4_FILTER_MAX_VALUES;

    afterEach(() => {
      if (originalMax === undefined) {
        delete process.env.MCP4_FILTER_MAX_VALUES;
      } else {
        process.env.MCP4_FILTER_MAX_VALUES = originalMax;
      }
    });

    it('defaults to 10 when unset', () => {
      delete process.env.MCP4_FILTER_MAX_VALUES;
      expect(getFilterMaxValues()).toBe(10);
    });

    it('rejects invalid values', () => {
      process.env.MCP4_FILTER_MAX_VALUES = '0';
      expect(() => getFilterMaxValues()).toThrow(ValidationError);
      process.env.MCP4_FILTER_MAX_VALUES = 'not-a-number';
      expect(() => getFilterMaxValues()).toThrow(ValidationError);
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

    it('allows any filtered value for read when _allow_read is present', () => {
      const filtering = { project_id: ['123'], _allow_read: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: '999' },
          operation: readOperation,
        })
      ).not.toThrow();
    });

    it('allows any filtered value for list when _allow_list is present', () => {
      const filtering = { project_id: ['123'], _allow_list: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'list', project_id: '999' },
          operation: listOperation,
        })
      ).not.toThrow();
    });

    it('still rejects values outside the allowed set for modify even with _allow_read and _allow_list', () => {
      const filtering = { project_id: ['123'], _allow_read: [], _allow_list: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'update', project_id: '999' },
          operation: undefined,
        })
      ).toThrow(AuthorizationError);
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

    it('returns early when only control keys are present', () => {
      const filtering = { _allow_list: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: {},
          operation: listOperation,
        })
      ).not.toThrow();
    });

    it('ignores filtering keys with empty allowed values', () => {
      const filtering = { project_id: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: {},
          operation: readOperation,
        })
      ).not.toThrow();
    });

    it('continues when another filter param is present for modify actions', () => {
      const filtering = { project_id: ['1'], other_id: ['2'] };
      const toolDef: ToolDefinition = {
        name: 'projects_multi',
        description: 'Project operations',
        operations: { update: 'updateProject' },
        parameters: {
          project_id: { type: 'string', description: 'Project ID' },
          other_id: { type: 'string', description: 'Other ID' },
        },
      };

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef,
          args: { project_id: '1' },
          operation: undefined,
        })
      ).not.toThrow();
    });

    it('treats unknown operations as modify even with _allow_read', () => {
      const filtering = { project_id: ['123'], _allow_read: [] };
      const toolDef: ToolDefinition = {
        name: 'projects_modify',
        description: 'Project modify',
        operations: {
          create: 'createProject',
        },
        parameters: {
          project_id: {
            type: 'string',
            description: 'Project ID',
          },
        },
      };

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef,
          args: {},
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

    it('rejects array arguments with non-primitive values', () => {
      const filtering = { project_id: ['1'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: [{ id: '1' }] },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('formats array and null values in errors', () => {
      const filtering = { project_id: ['1'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: [null] },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: [[]] },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('formats undefined values in errors', () => {
      const filtering = { project_id: ['1'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: [undefined] },
          operation: readOperation,
        })
      ).toThrow(AuthorizationError);
    });

    it('formats function values in errors', () => {
      const filtering = { project_id: ['1'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: [() => 'x'] },
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

    it('rejects filter keys not present in tool parameters', () => {
      const filtering = { merge_request_iid: ['8'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'update' },
          operation: undefined,
        })
      ).toThrow(ValidationError);
    });

    it('rejects unknown filter keys for the tool', () => {
      const filtering = { unknown_param: ['1'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get' },
          operation: readOperation,
        })
      ).toThrow(ValidationError);
    });

    it('reports required_for dependency with action name', () => {
      const toolDef: ToolDefinition = {
        name: 'issues',
        description: 'Issue operations',
        operations: { update: 'updateIssue' },
        parameters: {
          action: {
            type: 'string',
            description: 'Action',
            enum: ['update'],
          },
          issue_id: {
            type: 'string',
            description: 'Issue ID',
            required_for: ['update'],
          },
        },
      };
      const filtering = { issue_id: ['1'] };

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef,
          args: { action: 'update' },
          operation: undefined,
        })
      ).toThrow(/action 'update'/);
    });

    it('uses action fallback for list and read', () => {
      const filtering = { project_id: ['1'] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'list', project_id: '1' },
          operation: undefined,
        })
      ).not.toThrow();

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: '1' },
          operation: undefined,
        })
      ).not.toThrow();
    });

    it('handles search action as list operation', () => {
      const filtering = { project_id: ['1'], _allow_list: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'search' },
          operation: undefined,
        })
      ).not.toThrow();
    });

    it('handles read action as read operation', () => {
      const filtering = { project_id: ['1'], _allow_read: [] };
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'read' },
          operation: undefined,
        })
      ).not.toThrow();
    });

    it('validates primitives: string, number, boolean', () => {
      const filtering = { project_id: ['1', '2', 'true'] };
      
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: '1' },
          operation: readOperation,
        })
      ).not.toThrow();

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: 2 },
          operation: readOperation,
        })
      ).not.toThrow();

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: true },
          operation: readOperation,
        })
      ).not.toThrow();
    });

    it('handles POST/PUT/DELETE operations as modify', () => {
      const postOp: OperationInfo = {
        operationId: 'createProject',
        method: 'post',
        path: '/projects',
        parameters: [],
      };

      const filtering = { project_id: ['1'] };
      
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { project_id: '1' },
          operation: postOp,
        })
      ).not.toThrow();
    });

    it('deduplicates allowed values from multiple filter keys', () => {
      const filtering = { project_id: ['1', '2', '1'] };
      
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef: baseTool,
          args: { action: 'get', project_id: '1' },
          operation: readOperation,
        })
      ).not.toThrow();
    });

    it('validates when parameter has required=true', () => {
      const toolDef: ToolDefinition = {
        name: 'issues',
        description: 'Issue operations',
        operations: { update: 'updateIssue' },
        parameters: {
          issue_id: {
            type: 'string',
            description: 'Issue ID',
            required: true,
          },
        },
      };
      const filtering = { issue_id: ['1'] };

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef,
          args: { action: 'update' },
          operation: undefined,
        })
      ).toThrow(AuthorizationError);
    });

    it('allows empty filtering rules', () => {
      expect(() =>
        enforceFiltering({
          filtering: {},
          toolDef: baseTool,
          args: { action: 'list' },
          operation: listOperation,
        })
      ).not.toThrow();
    });

    it('handles parameter not defined in toolDef for required_for check', () => {
      const toolDef: ToolDefinition = {
        name: 'test',
        description: 'Test',
        operations: { update: 'update' },
        parameters: {
          action: {
            type: 'string',
            description: 'Action',
          },
        },
      };
      const filtering = { unknown_param: ['1'] };

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef,
          args: { action: 'update' },
          operation: undefined,
        })
      ).toThrow(ValidationError);
    });

    it('handles alias collision in toolParamGroups', () => {
      const toolDef: ToolDefinition = {
        name: 'test',
        description: 'Test',
        operations: { get: 'get' },
        parameters: {
          id: {
            type: 'string',
            description: 'ID',
          },
          project_id: {
            type: 'string',
            description: 'Project ID',
          },
        },
      };
      const filtering = { id: ['1'] };
      const parameterAliases = {
        project_id: ['id'],
      };

      // First alias wins (id -> project_id)
      expect(() =>
        enforceFiltering({
          filtering,
          toolDef,
          args: { id: '1', project_id: '1' },
          parameterAliases,
          operation: readOperation,
        })
      ).not.toThrow();
    });

    it('includes parameter keys in allowed keys even without aliases', () => {
      const toolDef: ToolDefinition = {
        name: 'test',
        description: 'Test',
        operations: { update: 'update' },
        parameters: {
          standalone_param: {
            type: 'string',
            description: 'Standalone',
          },
        },
      };
      const filtering = { standalone_param: ['value'] };

      expect(() =>
        enforceFiltering({
          filtering,
          toolDef,
          args: { standalone_param: 'value' },
          operation: undefined,
        })
      ).not.toThrow();
    });
  });
});
