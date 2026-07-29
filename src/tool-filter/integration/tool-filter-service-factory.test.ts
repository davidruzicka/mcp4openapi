import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../types/profile.js';
import { createToolFilterService } from './tool-filter-service-factory.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('createToolFilterService', () => {
  const tools: ToolDefinition[] = [
    {
      name: 'list_users',
      description: 'List users',
      parameters: {},
      operations: { list: 'listUsers' },
    },
    {
      name: 'delete_user',
      description: 'Delete user',
      parameters: {},
      operations: { delete: 'deleteUser' },
    },
  ];

  it('supports exact-name filtering without an OpenAPI parser', () => {
    const service = createToolFilterService({ logger: mockLogger as any });

    const result = service.applySessionFilter(tools, 'delete_user');

    expect(result.allowedToolNames).toEqual(new Set(['delete_user']));
  });

  it('enables category filtering when an OpenAPI parser is provided', () => {
    const parser = {
      getOperation: vi.fn((operationId: string) => {
        if (operationId === 'listUsers') {
          return { method: 'get', parameters: [] };
        }
        if (operationId === 'deleteUser') {
          return { method: 'delete', parameters: [] };
        }
        return undefined;
      }),
      getPath: vi.fn(),
    };

    const service = createToolFilterService({
      logger: mockLogger as any,
      parser: parser as any,
    });

    const result = service.applySessionFilter(tools, '_allow_list');

    expect(result.allowedToolNames).toEqual(new Set(['list_users']));
  });
});
