/**
 * Integration tests for HTTP transport with mocked message handler
 * 
 * Tests HTTP protocol compliance without full MCPServer complexity
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { HttpTransport } from '../transport/http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import type { Express } from 'express';
import { describeIfListen } from './listen-support.js';

describeIfListen('HTTP Transport Integration', () => {
  let transport: HttpTransport;
  let app: Express;
  let sessionId: string;
  const mockTools = [
    {
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
      },
    },
  ];

  beforeAll(async () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };

    const logger = new ConsoleLogger();
    transport = new HttpTransport(config, logger);
    app = (transport as any).app;

    // Set up mock message handler
    transport.setMessageHandler(async (message: unknown) => {
      const msg = message as any;
      
      if (msg.method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: {
              name: 'test-server',
              version: '1.0.0',
            },
            capabilities: {
              tools: {},
            },
          },
        };
      }

      if (msg.method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: mockTools,
          },
        };
      }

      if (msg.method === 'tools/call') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, message: 'Tool executed' }),
              },
            ],
          },
        };
      }

      // Batch request
      if (Array.isArray(msg)) {
        return msg.map((m: any) => {
          if (m.method === 'tools/list') {
            return {
              jsonrpc: '2.0',
              id: m.id,
              result: { tools: mockTools },
            };
          }
          return {
            jsonrpc: '2.0',
            id: m.id,
            result: { success: true },
          };
        });
      }

      return {
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: -32601,
          message: 'Method not found',
        },
      };
    });
  });

  afterAll(async () => {
    await transport.stop();
  });

  beforeEach(() => {
    // Reset session ID for each test
    sessionId = '';
  });

  describe('Initialization', () => {
    it('should initialize and create session', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeDefined();
      expect(response.body).toHaveProperty('jsonrpc', '2.0');
      expect(response.body).toHaveProperty('result');
      expect(response.body.result).toHaveProperty('protocolVersion', '2025-03-26');
      expect(response.body.result).toHaveProperty('serverInfo');
      
      // Save session ID for subsequent tests
      sessionId = response.headers['mcp-session-id'];
    });
  });

  describe('Tools List', () => {
    it('should list available tools', async () => {
      // Initialize first
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });
      sessionId = initResponse.headers['mcp-session-id'];

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('result');
      expect(response.body.result).toHaveProperty('tools');
      expect(Array.isArray(response.body.result.tools)).toBe(true);
      expect(response.body.result.tools.length).toBeGreaterThan(0);
      
      // Check tool structure
      const tool = response.body.result.tools[0];
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
    });
  });

  describe('Tool Execution', () => {
    beforeEach(async () => {
      // Initialize for each test
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });
      sessionId = initResponse.headers['mcp-session-id'];
    });

    it('should execute tool call', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'test_tool',
            arguments: {
              message: 'Hello',
            },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('result');
      expect(response.body.result).toHaveProperty('content');
      expect(Array.isArray(response.body.result.content)).toBe(true);
      
      const content = response.body.result.content[0];
      expect(content.type).toBe('text');
      
      const result = JSON.parse(content.text);
      expect(result).toHaveProperty('success', true);
    });

    it('should handle unknown method', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'unknown/method',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code', -32601);
      expect(response.body.error.message).toContain('Method not found');
    });
  });

  describe('SSE Streaming', () => {
    it('should support SSE response for requests', async () => {
      // Initialize first
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });
      sessionId = initResponse.headers['mcp-session-id'];

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/list',
          params: {},
        });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.text).toContain('id:');
      expect(response.text).toContain('data:');
      
      // Parse SSE data
      const lines = response.text.split('\n');
      const dataLine = lines.find(l => l.startsWith('data:'));
      expect(dataLine).toBeDefined();
      
      const data = JSON.parse(dataLine!.substring(5).trim());
      expect(data.result).toHaveProperty('tools');
    });
  });

  describe('Session Management', () => {
    it('should reject requests with invalid session', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', 'invalid-session-id')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/list',
          params: {},
        });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
      expect(response.body.message).toContain('Session not found');
    });

    it('should allow explicit session termination', async () => {
      // Create new session
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 8,
          method: 'initialize',
          params: {},
        });

      const tempSessionId = initResponse.headers['mcp-session-id'];
      expect(tempSessionId).toBeDefined();

      // Verify session works
      const listResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', tempSessionId)
        .send({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/list',
          params: {},
        });

      expect(listResponse.status).toBe(200);

      // Terminate session
      const deleteResponse = await request(app)
        .delete('/mcp')
        .set('Mcp-Session-Id', tempSessionId);

      expect(deleteResponse.status).toBe(204);

      // Verify session is gone
      const afterDeleteResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', tempSessionId)
        .send({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/list',
          params: {},
        });

      expect(afterDeleteResponse.status).toBe(404);
    });
  });

  describe('Batch Requests', () => {
    it('should handle batch of requests', async () => {
      // Initialize first
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {},
        });
      sessionId = initResponse.headers['mcp-session-id'];

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .send([
          {
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/list',
            params: {},
          },
          {
            jsonrpc: '2.0',
            id: 12,
            method: 'tools/call',
            params: {
              name: 'test_tool',
              arguments: { message: 'test' },
            },
          },
        ]);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      
      // Check each response
      expect(response.body[0]).toHaveProperty('id', 11);
      expect(response.body[0]).toHaveProperty('result');
      expect(response.body[1]).toHaveProperty('id', 12);
      expect(response.body[1]).toHaveProperty('result');
    });
  });

  describe('Health Check', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('sessions');
      expect(typeof response.body.sessions).toBe('number');
    });
  });
});
