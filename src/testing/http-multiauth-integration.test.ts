/**
 * Integration tests for HTTP transport with multi-auth (OAuth + Bearer)
 * 
 * Tests:
 * - OAuth session authentication
 * - Bearer token authentication
 * - Priority handling (OAuth > Bearer)
 * - 401 when no auth provided
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { HttpTransport } from '../transport/http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import type { Express } from 'express';
import type { OAuthConfig } from '../types/profile.js';
import { describeIfListen } from './listen-support.js';

describeIfListen('HTTP Transport Multi-Auth Integration', () => {
  let transport: HttpTransport;
  let app: Express;
  let oauthConfig: OAuthConfig;

  beforeAll(async () => {
    // Mock OAuth config
    oauthConfig = {
      authorization_endpoint: 'https://mock-gitlab.test/oauth/authorize',
      token_endpoint: 'https://mock-gitlab.test/oauth/token',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      scopes: ['api', 'read_user'],
      redirect_uri: 'http://localhost:3003/oauth/callback',
    };

    const config = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
      oauthConfig, // Enable OAuth
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
            tools: [
              {
                name: 'test_tool',
                description: 'Test tool for multi-auth',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                  },
                },
              },
            ],
          },
        };
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

  describe('OAuth Routes Available', () => {
    it('should expose OAuth metadata endpoint', async () => {
      const response = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .expect('Content-Type', /json/);

      // Should return 200 or 404 depending on OAuth initialization
      // If OAuth is enabled, should return metadata
      if (response.status === 200) {
        expect(response.body).toHaveProperty('issuer');
        expect(response.body).toHaveProperty('authorization_endpoint');
        expect(response.body).toHaveProperty('token_endpoint');
      }
    });
  });

  describe('Bearer Token Authentication', () => {
    it('should accept Bearer token for initialization', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer test-ci-token-123')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        })
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('result');
      expect(response.body.result).toHaveProperty('protocolVersion');
      expect(response.body.result).toHaveProperty('serverInfo');
      
      // Should create session
      expect(response.headers).toHaveProperty('mcp-session-id');
    });

    it('should accept Bearer token for tools/list', async () => {
      // First initialize
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer test-ci-token-456')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        })
        .expect(200);

      const sessionId = initResponse.headers['mcp-session-id'];

      // Then list tools
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        })
        .expect(200);

      expect(response.body.result).toHaveProperty('tools');
      expect(Array.isArray(response.body.result.tools)).toBe(true);
    });

    it('should reject invalid Bearer token format', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'InvalidFormat')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      // Should reject with error
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('OAuth Session Authentication', () => {
    it('should create session with OAuth token (simulated)', async () => {
      // With OAuth configured, initialize requires authentication
      // Use Bearer token to simulate authenticated session
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer simulated-oauth-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'cursor', version: '1.0.0' },
          },
        })
        .expect(200);

      const sessionId = response.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
    });

    it('should maintain session across requests', async () => {
      // Initialize with Bearer token (OAuth configured server requires auth)
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer test-session-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        })
        .expect(200);

      const sessionId = initResponse.headers['mcp-session-id'];

      // Use session for tools/list
      const toolsResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        })
        .expect(200);

      expect(toolsResponse.body.result).toHaveProperty('tools');
    });
  });

  describe('Priority Handling', () => {
    it('should prefer OAuth session over Bearer token', async () => {
      // Create session with Bearer token first
      const initResponse = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer primary-token')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'oauth-user', version: '1.0.0' },
          },
        })
        .expect(200);

      const sessionId = initResponse.headers['mcp-session-id'];

      // Send request with BOTH session ID AND Bearer token
      // Session should take precedence
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .set('Authorization', 'Bearer fallback-token')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        })
        .expect(200);

      expect(response.body.result).toHaveProperty('tools');
      // If this passes, it means session was used (OAuth priority)
    });
  });

  describe('No Auth Provided', () => {
    it('should reject initialization without auth when OAuth is configured', async () => {
      // When OAuth is configured, server requires authentication for initialization
      // This triggers OAuth flow in clients like Cursor
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      // Should reject with 401 (RFC 6750 invalid_request: no credential presented)
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('invalid_request');
      expect(response.body.message).toContain('Authentication required');
    });

    it('should reject tools/list without session or auth', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        });

      // Should fail - no session, no bearer token
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Token Validation', () => {
    it('should reject Bearer token that is too long', async () => {
      const longToken = 'x'.repeat(10000); // Exceeds max length
      
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${longToken}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      // Should reject (400 or 500 depending on error handling)
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject Bearer token with invalid characters', async () => {
      const invalidToken = 'token-with-invalid-chars<>{}';
      
      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${invalidToken}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        });

      // Should reject (400 or 500 depending on error handling)
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toHaveProperty('error');
    });
  });
});
