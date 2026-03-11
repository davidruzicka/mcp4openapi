import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { MCPServer } from '../mcp/mcp-server.js';
import { HttpTransport } from '../transport/http-transport.js';

let server: MCPServer;
let app: any;
let apiServer: Server;
let apiBaseUrl: string;
let itemReads = 0;
let listReads = 0;
const tempDirs: string[] = [];
const originalAllowPrivateNetwork = process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-http-apps-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

beforeAll(async () => {
  process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = 'true';
  apiServer = createServer((req, res) => {
    if (req.url === '/items') {
      listReads += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: '1' }, { id: '2' }]));
      return;
    }
    if (req.url === '/items/1') {
      itemReads += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ html: '<div>HTTP Item</div>' }));
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

  const specPath = await writeTempFile('openapi.yaml', `openapi: 3.0.0
info:
  title: HTTP Apps Test
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
    profile_name: 'http-apps',
    interceptors: {
      base_url: { value_from_env: 'UNUSED_HTTP_APPS_TEST_BASE_URL', default: apiBaseUrl },
    },
    tools: [
      {
        name: 'get_item',
        description: 'Get item',
        parameters: { item_id: { type: 'string', description: 'Item id', required: true } },
        operations: { get: 'getItem' },
      },
    ],
    resources: [
      {
        name: 'shell',
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
      },
    ],
  }), 'utf8');

  server = new MCPServer();
  await server.initialize(specPath, profilePath);
  await server.runHttp('127.0.0.1', 0);
  const transport = (server as any).httpTransport as HttpTransport;
  app = (transport as any).app;
});

afterAll(async () => {
  const transport = (server as any).httpTransport as HttpTransport;
  if (transport) {
    await transport.stop();
  }
  await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  if (originalAllowPrivateNetwork === undefined) {
    delete process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK;
  } else {
    process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK = originalAllowPrivateNetwork;
  }
});

describe('MCPServer HTTP apps resources', () => {
  it('serves resources/list, resources/read, and completion/complete over HTTP', async () => {
    const initResponse = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });

    const sessionId = initResponse.headers['mcp-session-id'];
    expect(sessionId).toBeDefined();

    const listResponse = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    const firstReadResponse = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://items/1' } });
    const secondReadResponse = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'ui://items/1' } });
    const completionResponse = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 5,
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/resource', uri: 'ui://items/{item_id}' },
          argument: { name: 'item_id', value: '1' },
        },
      });

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.result.resources).toEqual([
      expect.objectContaining({ uri: 'ui://shell' }),
    ]);
    expect(firstReadResponse.status).toBe(200);
    expect(firstReadResponse.body.result.contents[0].text).toContain('HTTP Item');
    expect(secondReadResponse.status).toBe(200);
    expect(secondReadResponse.body.result.contents[0].text).toContain('HTTP Item');
    expect(completionResponse.status).toBe(200);
    expect(completionResponse.body.result.completion.values).toEqual(['1']);
    expect(itemReads).toBe(1);
    expect(listReads).toBe(1);
  });
});
