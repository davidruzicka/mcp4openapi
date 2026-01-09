import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition } from './types/profile.js';
import {
  applyToolFilter,
  applySessionToolFilter,
  parseToolFilterConfig,
  parseSessionToolFilterHeader,
  detectListReadOperations,
  normalizeToolName
} from './tool-filter.js';
import { ConfigurationError, ValidationError } from './errors.js';

const baseParameters = {
  action: {
    type: 'string',
    description: 'Action',
    enum: ['list', 'get', 'delete'],
  },
  resource_type: {
    type: 'string',
    description: 'Resource type',
    enum: ['user'],
  },
};

const tools: ToolDefinition[] = [
  {
    name: 'get_user',
    description: 'Get user',
    operations: { get: 'getUser' },
    parameters: baseParameters,
  },
  {
    name: 'list_users',
    description: 'List users',
    operations: { list: 'listUsers' },
    parameters: baseParameters,
  },
  {
    name: 'delete_user',
    description: 'Delete user',
    operations: { delete: 'deleteUser' },
    parameters: baseParameters,
  },
  {
    name: 'composite_list_users',
    description: 'Composite list users',
    composite: true,
    steps: [{ call: 'GET /users', store_as: 'users' }],
    parameters: baseParameters,
  },
];

const unicodeTool: ToolDefinition = {
  name: 'cafe\u0301_tool',
  description: 'Unicode tool',
  operations: { get: 'getCafe' },
  parameters: baseParameters,
};

describe('tool filtering', () => {
  it('applies allow and deny lists with deny precedence', () => {
    const config = {
      allowList: ['get_user', 'list_users'],
      allowRegex: [],
      denyList: ['get_user'],
      denyRegex: [],
      allowComposite: { allowList: false, allowRead: false },
    };

    const result = applyToolFilter(tools, config);
    const names = result.allowed.map(tool => tool.name);

    expect(names).toEqual(['list_users']);
  });

  it('auto-anchors regex patterns', () => {
    const env = {
      MCP4_TOOL_FILTER_ALLOW_REGEX: 'get.*',
    } as NodeJS.ProcessEnv;
    const config = parseToolFilterConfig(env);
    expect(config).not.toBeNull();

    const result = applyToolFilter(tools, config!);
    const names = result.allowed.map(tool => tool.name);

    expect(names).toEqual(['get_user']);
  });

  it('rejects unsafe regex patterns', () => {
    const env = {
      MCP4_TOOL_FILTER_ALLOW_REGEX: '(a+)+b',
    } as NodeJS.ProcessEnv;

    expect(() => parseToolFilterConfig(env)).toThrow(ConfigurationError);
  });

  it('keeps case sensitivity for tool names', () => {
    const config = {
      allowList: ['Get_User'],
      allowRegex: [],
      denyList: [],
      denyRegex: [],
      allowComposite: { allowList: false, allowRead: false },
    };

    const result = applyToolFilter(tools, config);
    expect(result.allowed).toHaveLength(0);
  });

  it('allows composite tools via allow keywords', () => {
    const config = {
      allowList: [],
      allowRegex: [],
      denyList: [],
      denyRegex: [],
      allowComposite: { allowList: true, allowRead: false },
    };

    const result = applyToolFilter(tools, config);
    expect(result.allowed.map(tool => tool.name)).toEqual(['composite_list_users']);
  });

  it('normalizes unicode tool names for matching', () => {
    const config = {
      allowList: [normalizeToolName('café_tool')],
      allowRegex: [],
      denyList: [],
      denyRegex: [],
      allowComposite: { allowList: false, allowRead: false },
    };

    const result = applyToolFilter([unicodeTool], config);
    expect(result.allowed).toHaveLength(1);
  });
});

describe('session tool filtering', () => {
  it('parses allow list and regex entries', () => {
    const request = parseSessionToolFilterHeader('get_user, regex:list_.*', {
      maxEntries: 100,
      maxEntryLength: 255,
    });

    expect(request.allowNames).toEqual(['get_user']);
    expect(request.allowRegex).toHaveLength(1);
  });

  it('rejects oversized entries', () => {
    const longEntry = 'a'.repeat(256);
    expect(() =>
      parseSessionToolFilterHeader(longEntry, { maxEntries: 100, maxEntryLength: 255 })
    ).toThrow(ValidationError);
  });

  it('applies session allow rules', () => {
    const request = parseSessionToolFilterHeader('get_user, regex:list_.*', {
      maxEntries: 100,
      maxEntryLength: 255,
    });

    const result = applySessionToolFilter(tools, request);
    expect(result.allowedToolNames.has('get_user')).toBe(true);
    expect(result.allowedToolNames.has('list_users')).toBe(true);
    expect(result.allowedToolNames.has('delete_user')).toBe(false);
  });
});

describe('list/read detection', () => {
  it('detects list and read actions', () => {
    const composite = tools[3];
    const detection = detectListReadOperations(composite);
    expect(detection.isList).toBe(true);
    expect(detection.isRead).toBe(true);
  });
});
