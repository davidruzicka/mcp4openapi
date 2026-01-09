import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ToolDefinition } from './types/profile.js';
import type { OperationInfo } from './types/openapi.js';
import {
  applySessionToolFilter,
  applyToolFilter,
  parseSessionToolFilterHeader,
  parseToolFilterConfig,
  validateRegexPattern,
} from './tool-filter.js';
import { ConfigurationError, ValidationError } from './errors.js';

describe('tool filter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('auto-anchors regex patterns from environment', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_REGEX = 'user';
    const config = parseToolFilterConfig(process.env);
    expect(config?.allowRegex[0].source).toBe('^user$');

    process.env.MCP4_TOOL_FILTER_ALLOW_REGEX = '^user';
    const configWithPrefix = parseToolFilterConfig(process.env);
    expect(configWithPrefix?.allowRegex[0].source).toBe('^user$');

    process.env.MCP4_TOOL_FILTER_ALLOW_REGEX = '.*user.*';
    const configWithDots = parseToolFilterConfig(process.env);
    expect(configWithDots?.allowRegex[0].source).toBe('^.*user.*$');
  });

  it('returns undefined when no tool filter env vars are set', () => {
    delete process.env.MCP4_TOOL_FILTER_ALLOW_LIST;
    delete process.env.MCP4_TOOL_FILTER_ALLOW_REGEX;
    delete process.env.MCP4_TOOL_FILTER_DENY_LIST;
    delete process.env.MCP4_TOOL_FILTER_DENY_REGEX;
    delete process.env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES;
    expect(parseToolFilterConfig(process.env)).toBeUndefined();
  });

  it('rejects nested quantifier regex patterns', () => {
    const result = validateRegexPattern('(a+)+b');
    expect(result.valid).toBe(false);
  });

  it('rejects overly long regex patterns', () => {
    const longPattern = 'a'.repeat(101);
    const result = validateRegexPattern(longPattern);
    expect(result.valid).toBe(false);
  });

  it('enforces case-sensitive allow lists', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_LIST = 'GetUser';
    const config = parseToolFilterConfig(process.env);
    const tools: ToolDefinition[] = [
      {
        name: 'getuser',
        description: 'Lowercase tool',
        parameters: {},
        operations: { execute: 'getUser' },
      },
    ];
    const result = applyToolFilter(tools, config!);
    expect(result.allowed).toHaveLength(0);
  });

  it('denies tools when deny list matches allow list', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_LIST = 'get_user';
    process.env.MCP4_TOOL_FILTER_DENY_LIST = 'get_user';
    const config = parseToolFilterConfig(process.env);
    const tools: ToolDefinition[] = [
      {
        name: 'get_user',
        description: 'Get user',
        parameters: {},
        operations: { execute: 'getUser' },
      },
    ];
    const result = applyToolFilter(tools, config!);
    expect(result.allowed).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
  });

  it('allows composite tools with allow list keyword', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES = '_allow_list';
    const config = parseToolFilterConfig(process.env);
    const tools: ToolDefinition[] = [
      {
        name: 'list_things',
        description: 'Composite list',
        composite: true,
        steps: [{ call: 'GET /things', store_as: 'things' }],
        parameters: {},
      },
    ];
    const resolver = {
      getOperationForCall: () =>
        ({
          operationId: 'listThings',
          method: 'get',
          path: '/things',
          parameters: [],
        }) as OperationInfo,
    };
    const result = applyToolFilter(tools, config!, resolver);
    expect(result.allowed).toHaveLength(1);
  });

  it('normalizes tool names for unicode matches', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_LIST = 'café';
    const config = parseToolFilterConfig(process.env);
    const tools: ToolDefinition[] = [
      {
        name: 'cafe\u0301',
        description: 'Unicode tool',
        parameters: {},
        operations: { execute: 'getCafe' },
      },
    ];
    const result = applyToolFilter(tools, config!);
    expect(result.allowed).toHaveLength(1);
  });

  it('parses session header with regex entries and composite keywords', () => {
    const request = parseSessionToolFilterHeader('get_user, regex:read_.*, _allow_read');
    expect(request.exactNames.has('get_user')).toBe(true);
    expect(request.regexPatterns[0].source).toBe('^read_.*$');
    expect(request.allowComposite.allowRead).toBe(true);
  });

  it('handles empty session header as no rules', () => {
    const request = parseSessionToolFilterHeader('   ');
    expect(request.hasRules).toBe(false);
    expect(request.normalizedHeader).toBe('');
  });

  it('rejects session header entries that exceed length limit', () => {
    const tooLong = 'a'.repeat(256);
    expect(() => parseSessionToolFilterHeader(tooLong)).toThrow(ValidationError);
  });

  it('rejects invalid composite keyword in session header', () => {
    expect(() => parseSessionToolFilterHeader('_allow_write')).toThrow(ValidationError);
  });

  it('rejects invalid regex in session header', () => {
    expect(() => parseSessionToolFilterHeader('regex:(')).toThrow(ValidationError);
  });

  it('rejects invalid environment composite keyword', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES = '_allow_write';
    expect(() => parseToolFilterConfig(process.env)).toThrow(ConfigurationError);
  });

  it('rejects invalid session max entries configuration', () => {
    process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS = '0';
    expect(() => parseSessionToolFilterHeader('get_user')).toThrow(ConfigurationError);
  });

  it('rejects session headers that exceed max entry count', () => {
    const header = 'get_user, list_users';
    expect(() => parseSessionToolFilterHeader(header, 1)).toThrow(ValidationError);
  });

  it('rejects empty regex entries in session header', () => {
    expect(() => parseSessionToolFilterHeader('regex:')).toThrow(ValidationError);
  });

  it('rejects invalid allow regex patterns from environment', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_REGEX = '(';
    expect(() => parseToolFilterConfig(process.env)).toThrow(ConfigurationError);
  });

  it('denies tools that match deny regex without allow rules', () => {
    process.env.MCP4_TOOL_FILTER_DENY_REGEX = 'delete_.*';
    const config = parseToolFilterConfig(process.env);
    const tools: ToolDefinition[] = [
      {
        name: 'delete_user',
        description: 'Delete user',
        parameters: {},
        operations: { execute: 'deleteUser' },
      },
      {
        name: 'get_user',
        description: 'Get user',
        parameters: {},
        operations: { execute: 'getUser' },
      },
    ];
    const result = applyToolFilter(tools, config!);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0].name).toBe('get_user');
  });

  it('builds session allow set from header rules', () => {
    const request = parseSessionToolFilterHeader('regex:get_.*');
    const tools: ToolDefinition[] = [
      {
        name: 'get_user',
        description: 'Get user',
        parameters: {},
        operations: { execute: 'getUser' },
      },
      {
        name: 'delete_user',
        description: 'Delete user',
        parameters: {},
        operations: { execute: 'deleteUser' },
      },
    ];
    const sessionFilter = applySessionToolFilter(tools, request);
    expect(sessionFilter.allowedToolNames.has('get_user')).toBe(true);
    expect(sessionFilter.allowedToolNames.has('delete_user')).toBe(false);
  });

  it('applies session filter without rules to allow all tools', () => {
    const request = parseSessionToolFilterHeader('');
    const tools: ToolDefinition[] = [
      {
        name: 'alpha',
        description: 'Alpha',
        parameters: {},
        operations: { execute: 'alphaOp' },
      },
      {
        name: 'beta',
        description: 'Beta',
        parameters: {},
        operations: { execute: 'betaOp' },
      },
    ];
    const sessionFilter = applySessionToolFilter(tools, request);
    expect(sessionFilter.allowedToolNames.has('alpha')).toBe(true);
    expect(sessionFilter.allowedToolNames.has('beta')).toBe(true);
  });

  it('detects list and read operations from operation metadata', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'list_items',
        description: 'List items',
        parameters: {},
        operations: { list: 'listItems' },
      },
      {
        name: 'read_item',
        description: 'Read item',
        parameters: {},
        operations: { read: 'getItem' },
      },
      {
        name: 'create_item',
        description: 'Create item',
        parameters: {},
        operations: { create: 'createItem' },
      },
    ];
    const resolver = {
      getOperationById: (operationId: string) => {
        if (operationId === 'listItems') {
          return {
            operationId,
            method: 'get',
            path: '/items',
            parameters: [],
          } as OperationInfo;
        }
        if (operationId === 'getItem') {
          return {
            operationId,
            method: 'get',
            path: '/items/{id}',
            parameters: [{ in: 'path', name: 'id' }],
          } as OperationInfo;
        }
        if (operationId === 'createItem') {
          return {
            operationId,
            method: 'post',
            path: '/items',
            parameters: [],
          } as OperationInfo;
        }
        return undefined;
      },
    };

    process.env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES = '_allow_list,_allow_read';
    const config = parseToolFilterConfig(process.env);
    const result = applyToolFilter(tools, config!, resolver);
    expect(result.allowed.map(tool => tool.name)).toEqual(['list_items', 'read_item']);
  });

  it('detects list and read operations from action names', () => {
    process.env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES = '_allow_list,_allow_read';
    const config = parseToolFilterConfig(process.env);
    const tools: ToolDefinition[] = [
      {
        name: 'list_items',
        description: 'List items',
        parameters: {},
        operations: { list: 'listItems' },
      },
      {
        name: 'read_item',
        description: 'Read item',
        parameters: {},
        operations: { read: 'getItem' },
      },
    ];
    const result = applyToolFilter(tools, config!);
    expect(result.allowed).toHaveLength(2);
  });
});
