
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { MCPServer } from '../mcp-server.js';
import path from 'path';
import { HttpTransport } from '../http-transport.js';
import { describeIfListen } from './listen-support.js';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

describeIfListen('MCPServer HTTP Integration', () => {
  let server: MCPServer;
  let app: any;
  let originalEnv: NodeJS.ProcessEnv;
  let originalEnvKeys: Set<string>;
  let mockApiServer: Server;
  let mockApiBaseUrl: string;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    originalEnvKeys = new Set(Object.keys(process.env));
    mockApiServer = createServer((req, res) => {
      if (!req.url) {
        res.statusCode = 404;
        res.end();
        return;
      }

      if (req.url.startsWith('/api/v4/user') || req.url.startsWith('/api/v4/personal_access_tokens/self')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 1 }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      mockApiServer.listen(0, '127.0.0.1', () => {
        const address = mockApiServer.address() as AddressInfo;
        mockApiBaseUrl = `http://127.0.0.1:${address.port}/api/v4`;
        resolve();
      });
      mockApiServer.on('error', reject);
    });

    process.env.MCP4_OAUTH_ISSUER = 'https://gitlab.example.com';
    process.env.MCP4_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.MCP4_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.MCP4_OAUTH_REDIRECT_URI = 'http://127.0.0.1/oauth/callback';
    process.env.MCP4_API_BASE_URL = mockApiBaseUrl;
    process.env.MCP4_API_TOKEN = 'test-token';

    server = new MCPServer();
    
    // Use GitLab profile for testing
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json');
    
    await server.initialize(specPath, profilePath);
    
    // Start server in HTTP mode
    // We use port 0 to let OS assign a random port, but we need to access the app instance
    // MCPServer doesn't expose app directly, but we can access it via httpTransport
    await server.runHttp('127.0.0.1', 0);
    
    // Access the underlying express app for supertest
    const transport = (server as any).httpTransport as HttpTransport;
    app = (transport as any).app;
  });

  afterAll(async () => {
    // Stop server
    const transport = (server as any).httpTransport as HttpTransport;
    if (transport) {
      await transport.stop();
    }
    if (mockApiServer) {
      await new Promise<void>((resolve, reject) => {
        mockApiServer.close(err => (err ? reject(err) : resolve()));
      });
    }
    for (const key of Object.keys(process.env)) {
      if (!originalEnvKeys.has(key)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it('should handle initialize request via HTTP', async () => {
    const response = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer test-token')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0'
          }
        }
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('result');
    expect(response.body.result).toHaveProperty('serverInfo');
    expect(response.body.result.serverInfo.name).toBe('mcp4openapi');
  });

  it('should handle tools/list request via HTTP', async () => {
    // First create a session via initialize (or just send request if session not strictly required for list? 
    // HttpTransport requires session for most things, but initialize creates one)
    
    // Actually, HttpTransport handles session creation on initialize.
    // But supertest requests are stateless unless we persist cookies/headers.
    // HttpTransport returns X-Mcp-Session-Id header.
    
    const initResponse = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer test-token')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });
      
    const sessionId = initResponse.headers['mcp-session-id'];
    expect(sessionId).toBeDefined();

    const response = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('result');
    expect(response.body.result).toHaveProperty('tools');
    expect(Array.isArray(response.body.result.tools)).toBe(true);
  });

  it('should handle tools/call request via HTTP', async () => {
    // Initialize session
    const initResponse = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer test-token')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' }
        }
      });
      
    const sessionId = initResponse.headers['mcp-session-id'];

    // Call a tool (e.g. manage_project_badges list)
    // We need to mock the backend API call because MCPServer will try to call GitLab
    // But here we just want to test the routing in MCPServer.
    // If we don't mock, it will fail or try to hit real API.
    // We can mock the executeSimpleTool method on the server instance?
    
    // Or we can just check that it *tries* to execute and fails with a specific error (e.g. 401 or 404 from GitLab),
    // which proves it reached handleToolCall.
    
    // Let's try calling a tool and expect an error from the backend (or mock it).
    // Mocking executeSimpleTool is safer.
    
    const originalExecute = (server as any).executeSimpleTool;
    let toolCalled = false;
    (server as any).executeSimpleTool = async () => {
      toolCalled = true;
      return { success: true };
    };

    try {
      const response = await request(app)
        .post('/mcp')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'manage_project_badges',
            arguments: {
              project_id: 'test',
              action: 'list'
            }
          }
        });

      expect(response.status).toBe(200);
      expect(toolCalled).toBe(true);
      expect(response.body.result.content[0].text).toContain('success');
    } finally {
      (server as any).executeSimpleTool = originalExecute;
    }
  });

  it('should return 404 for invalid session ID', async () => {
    const response = await request(app)
      .post('/mcp')
      .set('Mcp-Session-Id', 'invalid-session-id')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });

    expect(response.status).toBe(404);
  });

  it('should return 400 for missing session ID on non-init request', async () => {
    const response = await request(app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      });

    expect(response.status).toBe(400);
  });
});
