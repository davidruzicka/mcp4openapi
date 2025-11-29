/**
 * Integration test for HTTP transport in multi-user mode (no MCP4_API_TOKEN in env)
 * 
 * Tests that:
 * 1. Server can start without MCP4_API_TOKEN env var
 * 2. Clients can send tokens in Authorization header
 * 3. Each session uses its own token
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { HttpTransport } from '../http-transport.js';
import { ConsoleLogger } from '../logger.js';
import request from 'supertest';
import type { Express } from 'express';

describe('HTTP Multi-User Mode (No MCP4_API_TOKEN)', () => {
  let httpTransport: HttpTransport;
  let app: Express;
  
  // Save original env
  const originalApiToken = process.env.MCP4_API_TOKEN;
  
  beforeAll(() => {
    // IMPORTANT: Remove MCP4_API_TOKEN from env to test multi-user mode
    delete process.env.MCP4_API_TOKEN;
    
    const logger = new ConsoleLogger('error'); // Quiet during tests
    
    const config = {
      host: '127.0.0.1',
      port: 0, // Port 0 for supertest - doesn't actually listen
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };
    
    httpTransport = new HttpTransport(config, logger);
    app = (httpTransport as any).app;
    
    // Set up simple mock message handler
    httpTransport.setMessageHandler(async (message: unknown, sessionId?: string) => {
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
                description: 'Test',
                inputSchema: { type: 'object', properties: {} }
              }
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
    await httpTransport.stop();
    // Restore original env
    if (originalApiToken) {
      process.env.MCP4_API_TOKEN = originalApiToken;
    } else {
      delete process.env.MCP4_API_TOKEN;
    }
  });
  
  describe('Server Initialization', () => {
    it('should start successfully without MCP4_API_TOKEN env var', async () => {
      expect(process.env.MCP4_API_TOKEN).toBeUndefined();
      expect(app).toBeDefined();
      
      // Health check should work
      const response = await request(app).get('/health');
      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
    });
  });
  
  describe('Client Authentication', () => {
    it('should accept initialization with Authorization header', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', 'Bearer glpat-test-token-123')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: {
              name: 'test-client',
              version: '1.0.0'
            }
          }
        });
      
      expect(response.status).toBe(200);
      expect(response.body.result).toBeDefined();
      expect(response.body.result.protocolVersion).toBe('2025-03-26');
      expect(response.headers['mcp-session-id']).toBeDefined();
    });
    
    it('should accept initialization with X-API-Token header', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('X-API-Token', 'glpat-test-token-456')
        .send({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: {
              name: 'test-client-2',
              version: '1.0.0'
            }
          }
        });
      
      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeDefined();
    });
    
    it('should create separate sessions for different tokens', async () => {
      // Client 1
      const response1 = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', 'Bearer token-user-1')
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'client-1', version: '1.0.0' }
          }
        });
      
      const sessionId1 = response1.headers['mcp-session-id'];
      expect(sessionId1).toBeDefined();
      
      // Client 2
      const response2 = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', 'Bearer token-user-2')
        .send({
          jsonrpc: '2.0',
          id: 4,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'client-2', version: '1.0.0' }
          }
        });
      
      const sessionId2 = response2.headers['mcp-session-id'];
      expect(sessionId2).toBeDefined();
      
      // Sessions should be different
      expect(sessionId1).not.toBe(sessionId2);
    });
  });
  
  describe('Security', () => {
    it('should reject malformed Authorization header', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', 'InvalidFormat token')
        .send({
          jsonrpc: '2.0',
          id: 5,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        });
      
      // P0#2 fix: Now properly rejects invalid format
      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Internal Server Error');
      expect(response.body.message).toContain('Invalid Authorization header format');
    });
    
    it('should handle initialization without any token gracefully', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 6,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        });
      
      // Should create session, token will be checked on first tool call
      expect(response.status).toBe(200);
    });
    
    it('should accept GitLab-style tokens (glpat-)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', 'Bearer glpat-test_token_12345')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        });
      
      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeDefined();
    });
    
    it('should accept YouTrack-style tokens (perm:)', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', 'Bearer perm:test.token.12345')
        .send({
          jsonrpc: '2.0',
          id: 8,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        });
      
      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeDefined();
    });
    
    it('should handle extra whitespace in Authorization header', async () => {
      const response = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', '  Bearer   test-token-123  ')
        .send({
          jsonrpc: '2.0',
          id: 9,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        });
      
      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeDefined();
    });
  });
  
  describe('Token Storage', () => {
    it('should store token in session and use it for subsequent requests', async () => {
      // Initialize with token
      const initResponse = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Authorization', 'Bearer session-token-test')
        .send({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        });
      
      const sessionId = initResponse.headers['mcp-session-id'];
      expect(sessionId).toBeDefined();
      
      // List tools without token in header (should use session token)
      const toolsResponse = await request(app)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/list',
          params: {}
        });
      
      expect(toolsResponse.status).toBe(200);
      expect(toolsResponse.body.result).toBeDefined();
    });
  });
});

