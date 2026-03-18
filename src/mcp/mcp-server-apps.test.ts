import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import { CompleteRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPServer } from './mcp-server.js';

let apiServer: Server;
let apiBaseUrl: string;
const tempDirs: string[] = [];
const originalAllowPrivateNetwork = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-apps-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

beforeAll(async () => {
  process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
  apiServer = createServer((req, res) => {
    if (req.url === '/items') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: '1' }, { id: '2' }]));
      return;
    }
    if (req.url === '/items/1') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: '1', html: '<div>Item 1</div>' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    apiServer.listen(0, '127.0.0.1', () => {
      const address = apiServer.address() as AddressInfo;
      apiBaseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    apiServer.on('error', reject);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  if (originalAllowPrivateNetwork === undefined) {
    delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
  } else {
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = originalAllowPrivateNetwork;
  }
});

async function createServerFixture() {
  const server = new MCPServer();
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-server-apps-fixture-'));
  tempDirs.push(fixtureDir);

  const specPath = path.join(fixtureDir, 'openapi.yaml');
  const profilePath = path.join(fixtureDir, 'profile.json');
  const staticShellPath = path.join(fixtureDir, 'static-shell.html');

  await fs.writeFile(staticShellPath, '<div>File Shell</div>', 'utf8');
  await fs.writeFile(specPath, `openapi: 3.0.0
info:
  title: Server Apps Test
  version: 1.0.0
servers:
  - url: ${apiBaseUrl}
paths:
  /items:
    get:
      operationId: listItems
      responses:
        '200':
          description: ok
  /items/{item_id}:
    get:
      operationId: getItem
      parameters:
        - in: path
          name: item_id
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
`, 'utf8');
  await fs.writeFile(profilePath, JSON.stringify({
    profile_name: 'apps-server',
    interceptors: {
      base_url: { value_from_env: 'UNUSED_APPS_TEST_BASE_URL', default: apiBaseUrl },
    },
    tools: [
      {
        name: 'get_item',
        description: 'Get item',
        parameters: {
          item_id: { type: 'string', description: 'Item id', required: true },
        },
        operations: { get: 'getItem' },
        apps: {
          output_template_resource_uri: 'ui://items/{item_id}',
          invocation_text: { invoking: 'Loading item', invoked: 'Loaded item' },
          annotations: { title: 'Item widget', readOnlyHint: true },
        },
      },
    ],
    resources: [
      {
        name: 'static_shell',
        kind: 'static',
        uri: 'ui://shell',
        mime_type: 'text/html',
        inline_text: '<div>Shell</div>',
      },
      {
        name: 'static_file_shell',
        kind: 'static',
        uri: 'ui://file-shell',
        mime_type: 'text/html',
        file_path: './static-shell.html',
      },
      {
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: {
          source: 'operation',
          operation: 'getItem',
          parameter_mapping: { item_id: 'item_id' },
          result_path: 'html',
          cache_ttl_seconds: 60,
        },
        completion: {
          variables: {
            item_id: {
              source: 'operation',
              operation: 'listItems',
              value_path: 'id',
            },
          },
        },
        apps: {
          widget_description: 'Item widget',
        },
      },
    ],
  }), 'utf8');

  await server.initialize(specPath, profilePath);
  return server;
}

describe('MCPServer apps resources', () => {
  it('lists resources, templates, and tool metadata', async () => {
    const server = await createServerFixture();

    const toolsResponse = await (server as any).handleOtherRequest({ jsonrpc: '2.0', id: '1', method: 'tools/list' });
    const resourcesResponse = await (server as any).handleOtherRequest({ jsonrpc: '2.0', id: '2', method: 'resources/list' });
    const templatesResponse = await (server as any).handleOtherRequest({ jsonrpc: '2.0', id: '3', method: 'resources/templates/list' });

    expect(toolsResponse.result.tools[0]._meta['openai/outputTemplate']).toBe('ui://items/{item_id}');
    expect(resourcesResponse.result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'ui://shell', name: 'static_shell' }),
      expect.objectContaining({ uri: 'ui://file-shell', name: 'static_file_shell' }),
    ]));
    expect(templatesResponse.result.resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: 'ui://items/{item_id}', name: 'item_template' }),
    ]);
  });

  it('returns empty resource collections when no apps model is loaded', () => {
    const server = new MCPServer();

    expect((server as any).listResources()).toEqual([]);
    expect((server as any).listResourceTemplates()).toEqual([]);
  });

  it('reads static and fetch-backed resources and resolves completions', async () => {
    const server = await createServerFixture();

    const staticResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: '4',
      method: 'resources/read',
      params: { uri: 'ui://shell' },
    });
    const dynamicResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: '5',
      method: 'resources/read',
      params: { uri: 'ui://items/1' },
    });
    const completionResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: '6',
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/resource', uri: 'ui://items/{item_id}' },
        argument: { name: 'item_id', value: '1' },
      },
    });

    expect(staticResponse.result.contents[0].text).toContain('Shell');
    expect(dynamicResponse.result.contents[0].text).toContain('Item 1');
    expect(completionResponse.result.completion.values).toEqual(['1']);
  });

  it('returns consistent resource content shape for inline file and fetch-backed resources', async () => {
    const server = await createServerFixture();

    const inlineResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: 'inline',
      method: 'resources/read',
      params: { uri: 'ui://shell' },
    });
    const fileResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: 'file',
      method: 'resources/read',
      params: { uri: 'ui://file-shell' },
    });
    const fetchResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: 'fetch',
      method: 'resources/read',
      params: { uri: 'ui://items/1' },
    });

    expect(inlineResponse.result.contents[0]).toEqual(expect.objectContaining({
      uri: 'ui://shell',
      mimeType: 'text/html',
      text: '<div>Shell</div>',
    }));
    expect(fileResponse.result.contents[0]).toEqual(expect.objectContaining({
      uri: 'ui://file-shell',
      mimeType: 'text/html',
      text: '<div>File Shell</div>',
    }));
    expect(fetchResponse.result.contents[0]).toEqual(expect.objectContaining({
      uri: 'ui://items/1',
      mimeType: 'text/html',
      text: '<div>Item 1</div>',
    }));
    expect(typeof inlineResponse.result.contents[0].text).toBe('string');
    expect(typeof fileResponse.result.contents[0].text).toBe('string');
    expect(typeof fetchResponse.result.contents[0].text).toBe('string');
  });

  it('returns validation errors for malformed resource and completion requests', async () => {
    const server = await createServerFixture();

    const invalidReadResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: 'invalid-read',
      method: 'resources/read',
      params: {},
    });
    const invalidCompletionResponse = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: 'invalid-completion',
      method: 'completion/complete',
      params: {
        ref: { type: 'other', uri: 'ui://items/{item_id}' },
        argument: { name: 'item_id', value: '1' },
      },
    });

    expect(invalidReadResponse.error).toMatchObject({
      code: -32602,
    });
    expect(invalidReadResponse.error.message).toContain('resources/read requires string parameter "uri"');

    expect(invalidCompletionResponse.error).toMatchObject({
      code: -32602,
    });
    expect(invalidCompletionResponse.error.message).toContain('completion/complete requires a resource ref');
  });

  it('propagates session context to fetch-backed resource and completion lookups', async () => {
    const server = await createServerFixture();
    const getHttpClientForSessionSpy = vi.spyOn(server as any, 'getHttpClientForSession');

    await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: '7',
      method: 'resources/read',
      params: { uri: 'ui://items/1' },
    }, 'session-123');

    await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: '8',
      method: 'completion/complete',
      params: {
        ref: { type: 'ref/resource', uri: 'ui://items/{item_id}' },
        argument: { name: 'item_id', value: '1' },
      },
    }, 'session-123');

    expect(getHttpClientForSessionSpy).toHaveBeenCalledWith('session-123', undefined);
  });

  it('returns method-level errors for unknown resources', async () => {
    const server = await createServerFixture();

    const response = await (server as any).handleOtherRequest({
      jsonrpc: '2.0',
      id: '9',
      method: 'resources/read',
      params: { uri: 'ui://missing' },
    });

    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain('Resource not found');
  });

  it('returns validation errors for ambiguous resource matches and missing completion variables', async () => {
    const server = await createServerFixture();
    const templateResource = (server as any).appsModel.templateResources[0];
    (server as any).appsModel.templateResources.push({ ...templateResource, name: 'duplicate_template' });

    await expect((server as any).readResource('ui://items/1')).rejects.toThrow("Ambiguous resource uri 'ui://items/1'");

    (server as any).appsModel.templateResources = [templateResource];
    await expect((server as any).completeResourceArgument({
      params: {
        ref: { type: 'ref/resource', uri: 'ui://items/{item_id}' },
        argument: { name: 'other_id', value: '1' },
      },
    })).rejects.toThrow("No completion configured for variable 'other_id'");
  });

  it('uses fallback template matching and handles static completion filtering', async () => {
    const server = await createServerFixture();
    const templateResource = (server as any).appsModel.templateResources[0];
    (server as any).appsModel.templateResourcesByUriTemplate.clear();
    templateResource.completion = {
      variables: {
        item_id: {
          source: 'static',
          values: ['1', '11', '22'],
          parameterMapping: {},
          timeoutMs: 1000,
          maxValues: 100,
        },
      },
    };

    const response = await (server as any).completeResourceArgument({
      params: {
        ref: { type: 'ref/resource', uri: 'ui://items/1' },
        argument: { name: 'item_id', value: '1' },
      },
    });

    expect(response.completion.values).toEqual(['1', '11']);
  });

  it('caches fetched resource content and stringifies non-string fetch results', async () => {
    const server = new MCPServer();
    const executeAppsFetch = vi.fn().mockResolvedValue({ html: { nested: true } });
    (server as any).executeAppsFetch = executeAppsFetch;

    const strategy = {
      source: 'operation',
      operation: 'getItem',
      parameterMapping: {},
      resultPath: 'html',
      cacheTtlSeconds: 60,
      timeoutMs: 1000,
    };

    const first = await (server as any).fetchResourceContent(strategy, {}, 'session-1', 'default');
    const second = await (server as any).fetchResourceContent(strategy, {}, 'session-1', 'default');

    expect(first).toBe(JSON.stringify({ nested: true }, null, 2));
    expect(second).toBe(first);
    expect(executeAppsFetch).toHaveBeenCalledTimes(1);
  });

  it('covers low-level apps fetch helpers and error branches', async () => {
    const server = new MCPServer();

    expect(await (server as any).fetchResourceContent(undefined, {})).toBeUndefined();
    expect((server as any).extractCompletionValue('1', { valuePath: 'id', labelPath: undefined })).toBe('1');
    expect((server as any).extractCompletionValue(null, { valuePath: 'id', labelPath: undefined })).toBeUndefined();
    expect((server as any).buildAppsFetchCacheKey({ cacheTtlSeconds: 0 }, {}, undefined, undefined)).toBeUndefined();
    expect((server as any).buildMappedInput({ item_id: '1' }, {})).toEqual({ item_id: '1' });
    expect((server as any).buildMappedInput({ item_id: '1' }, { target: 'item_id', skipped: 'missing' })).toEqual({ target: '1' });

    vi.useFakeTimers();
    try {
      (server as any).executeAppsOperation = vi.fn().mockImplementation(() => new Promise(() => {}));
      const timedFetch = (server as any).executeAppsFetch({
        source: 'operation',
        operation: 'getItem',
        parameterMapping: {},
        timeoutMs: 1,
      }, {});
      const timedFetchAssertion = expect(timedFetch).rejects.toThrow('Apps fetch timed out');
      await vi.advanceTimersByTimeAsync(1);
      await timedFetchAssertion;
    } finally {
      vi.useRealTimers();
    }

    delete (server as any).executeAppsOperation;
    (server as any).parser = { getOperation: () => undefined };
    await expect((server as any).executeAppsOperation('missingOperation', {})).rejects.toThrow('Operation not found: missingOperation');

    (server as any).profile = { tools: [] };
    await expect((server as any).executeAppsComposite('missingComposite', {})).rejects.toThrow('Composite tool not found: missingComposite');
  });

  it('covers MCP apps handlers, initialize capabilities, and composite fetch success paths', async () => {
    const server = await createServerFixture();
    const handlers = new Map<unknown, (request?: any) => Promise<unknown>>();
    const originalSetRequestHandler = (server as any).server.setRequestHandler.bind((server as any).server);
    (server as any).server.setRequestHandler = (schema: unknown, handler: (request?: any) => Promise<unknown>) => {
      handlers.set(schema, handler);
      return originalSetRequestHandler(schema, handler);
    };

    (server as any).setupHandlers();

    await expect(handlers.get(ListToolsRequestSchema)!()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: 'get_item' })],
    });
    await expect(handlers.get(ListResourcesRequestSchema)!()).resolves.toEqual({
      resources: expect.arrayContaining([
        expect.objectContaining({ uri: 'ui://shell' }),
        expect.objectContaining({ uri: 'ui://file-shell' }),
      ]),
    });
    await expect(handlers.get(ListResourceTemplatesRequestSchema)!()).resolves.toEqual({
      resourceTemplates: [expect.objectContaining({ uriTemplate: 'ui://items/{item_id}' })],
    });
    await expect(handlers.get(ReadResourceRequestSchema)!({ params: { uri: 'ui://shell' } })).resolves.toEqual({
      contents: [expect.objectContaining({ uri: 'ui://shell', text: '<div>Shell</div>' })],
    });
    await expect(handlers.get(CompleteRequestSchema)!({
      params: {
        ref: { type: 'ref/resource', uri: 'ui://items/{item_id}' },
        argument: { name: 'item_id', value: '1' },
      },
    })).resolves.toEqual({
      completion: { values: ['1'], total: 1, hasMore: false },
    });

    const initializeResponse = (server as any).handleInitialize({ jsonrpc: '2.0', id: 'init' }, undefined, undefined);
    expect(initializeResponse.result.capabilities).toEqual({
      tools: {},
      prompts: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      completions: {},
    });

    const fixedFetchServer = new MCPServer();
    (fixedFetchServer as any).appsModel = {
      resourcesByUri: new Map([['ui://cached', {
        uri: 'ui://cached',
        mimeType: 'text/plain',
        appsMeta: { source: 'fetch' },
        fetchStrategy: {
          source: 'operation',
          operation: 'getItem',
          parameterMapping: {},
          timeoutMs: 1000,
        },
      }]]),
      templateResources: [],
      templateResourcesByUriTemplate: new Map(),
    };
    (fixedFetchServer as any).fetchResourceContent = vi.fn().mockResolvedValue('fetched shell');
    await expect((fixedFetchServer as any).readResource('ui://cached')).resolves.toEqual({
      contents: [{ uri: 'ui://cached', mimeType: 'text/plain', _meta: { source: 'fetch' }, text: 'fetched shell' }],
    });

    const missingTextServer = new MCPServer();
    (missingTextServer as any).appsModel = {
      resourcesByUri: new Map(),
      templateResources: [{
        name: 'template',
        uriTemplate: 'ui://items/{item_id}',
        mimeType: 'text/html',
        staticText: undefined,
        fetchStrategy: { source: 'operation', operation: 'getItem', parameterMapping: {}, timeoutMs: 1000 },
        variables: ['item_id'],
        matcher: /^ui:\/\/items\/([^/?#]+)$/,
      }],
      templateResourcesByUriTemplate: new Map(),
    };
    (missingTextServer as any).fetchResourceContent = vi.fn().mockResolvedValue(undefined);
    await expect((missingTextServer as any).readResource('ui://items/1')).rejects.toThrow("Resource not found: ui://items/1");
    await expect((missingTextServer as any).completeResourceArgument({
      params: {
        ref: { type: 'ref/resource', uri: 'ui://items/{item_id}' },
        argument: { name: 'item_id' },
      },
    })).rejects.toThrow('completion/complete requires argument.name and argument.value');
    await expect((missingTextServer as any).completeResourceArgument({
      params: {
        ref: { type: 'ref/resource', uri: 'ui://missing/{id}' },
        argument: { name: 'id', value: '1' },
      },
    })).rejects.toThrow('Resource template not found: ui://missing/{id}');

    const compositeServer = new MCPServer();
    (compositeServer as any).profile = {
      tools: [{ name: 'composite_fetch', steps: [{ call: 'GET /items', store_as: 'items' }] }],
    };
    (compositeServer as any).compositeExecutor = {
      execute: vi.fn().mockResolvedValue({ data: { id: '1' } }),
    };
    (compositeServer as any).getHttpClientForSession = vi.fn().mockResolvedValue({});
    await expect((compositeServer as any).executeAppsComposite('composite_fetch', { item_id: '1' }, 'session-5', 'default')).resolves.toEqual({ id: '1' });
  });
});
