import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
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
  const specPath = await writeTempFile('openapi.yaml', `openapi: 3.0.0
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
`);
  const profilePath = await writeTempFile('profile.json', JSON.stringify({
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
    expect(resourcesResponse.result.resources).toEqual([
      expect.objectContaining({ uri: 'ui://shell', name: 'static_shell' }),
    ]);
    expect(templatesResponse.result.resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: 'ui://items/{item_id}', name: 'item_template' }),
    ]);
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
});
