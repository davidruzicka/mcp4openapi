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
import { ConsoleLogger, LogLevel } from '../logger.js';
import type { Express } from 'express';
import { describeIfListen } from './listen-support.js';

describeIfListen('HTTP Multi-User Mode (No MCP4_API_TOKEN)', () => {
  let httpTransport: HttpTransport;
  let app: Express;
  let baseUrl: string;
  
  // Save original env
  const originalApiToken = process.env.MCP4_API_TOKEN;
  
  beforeAll(async () => {
    // IMPORTANT: Remove MCP4_API_TOKEN from env to test multi-user mode
    delete process.env.MCP4_API_TOKEN;
    
    const logger = new ConsoleLogger(LogLevel.ERROR); // Quiet during tests
    
    const config = {
      host: '127.0.0.1',
      port: 0, // Port 0 selects an ephemeral port
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };
    
    httpTransport = new HttpTransport(config, logger);
    app = (httpTransport as any).app;
    await httpTransport.start();

    const server = (httpTransport as any).server;
    const address = server?.address?.();
    if (!address || typeof address !== 'object' || !('port' in address)) {
      throw new Error('HTTP transport did not expose a usable server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    
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
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.status).toBe('ok');
    });
  });
  
  describe('Client Authentication', () => {
    it('should accept initialization with Authorization header', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer glpat-test-token-123',
        },
        body: JSON.stringify({
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
        }),
      });
      
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.result).toBeDefined();
      expect(body.result.protocolVersion).toBe('2025-03-26');
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
    });
    
    it('should accept initialization with X-API-Token header', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-Token': 'glpat-test-token-456',
        },
        body: JSON.stringify({
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
        }),
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
    });
    
    it('should create separate sessions for different tokens', async () => {
      // Client 1
      const response1 = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer token-user-1',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'client-1', version: '1.0.0' }
          }
        }),
      });
      
      const sessionId1 = response1.headers.get('mcp-session-id');
      expect(sessionId1).toBeTruthy();
      
      // Client 2
      const response2 = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer token-user-2',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'client-2', version: '1.0.0' }
          }
        }),
      });
      
      const sessionId2 = response2.headers.get('mcp-session-id');
      expect(sessionId2).toBeTruthy();
      
      // Sessions should be different
      expect(sessionId1).not.toBe(sessionId2);
    });
  });
  
  describe('Security', () => {
    it('should reject malformed Authorization header', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'InvalidFormat token',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        }),
	      });
	      
	      // Invalid auth header format should be rejected as a client error
	      expect(response.status).toBe(400);
	      const body = await response.json() as any;
	      expect(body.error).toBe('Bad Request');
	      expect(body.correlationId).toBeTruthy();
	      expect(body.message).toContain('Invalid Authorization header format');
	    });
    
    it('should handle initialization without any token gracefully', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        }),
      });
      
      // Should create session, token will be checked on first tool call
      expect(response.status).toBe(200);
    });
    
    it('should accept GitLab-style tokens (glpat-)', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer glpat-test_token_12345',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        }),
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
    });
    
    it('should accept YouTrack-style tokens (perm:)', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer perm:test.token.12345',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        }),
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
    });
    
    it('should handle extra whitespace in Authorization header', async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': '  Bearer   test-token-123  ',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        }),
      });
      
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeTruthy();
    });
  });
  
  describe('Token Storage', () => {
    it('should store token in session and use it for subsequent requests', async () => {
      // Initialize with token
      const initResponse = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': 'Bearer session-token-test',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'test', version: '1.0.0' }
          }
        }),
      });
      
      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();
      
      // List tools without token in header (should use session token)
      const toolsResponse = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Mcp-Session-Id': sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/list',
          params: {}
        }),
      });
      
      expect(toolsResponse.status).toBe(200);
      const body = await toolsResponse.json() as any;
      expect(body.result).toBeDefined();
    });
  });
});
