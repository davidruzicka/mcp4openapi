import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

vi.mock('./http-transport.js', () => {
  class HttpTransport {
    public start = vi.fn(async () => {});
    public stop = vi.fn(async () => {});
    public setMessageHandler = vi.fn((_handler: any) => {});
    public onSessionDestroyed = vi.fn((_handler: any) => {});
    public hasOAuthProvider = vi.fn(() => false);
    public getServerUrl = vi.fn(() => 'http://127.0.0.1:0');
    public ensureValidSessionToken = vi.fn(async () => true);
    public getSessionToken = vi.fn((_sessionId: string) => undefined);

    constructor(public config: any, public logger: any) {}
  }

  return { HttpTransport };
});

import { MCPServer } from './mcp-server.js';

describe('MCPServer HTTP transport wiring (no listen)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('runHttp wires HttpTransport without listening', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    process.env.MCP4_OAUTH_SESSION_TIMEOUT_MS = '1234';
    process.env.MCP4_OAUTH_REFRESH_THRESHOLD_MS = '567';

    const server = new MCPServer(logger as any);
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    await server.initialize(specPath);

    delete process.env.MCP4_ALLOWED_ORIGINS;

    await server.runHttp('0.0.0.0', 3003);

    const transport = (server as any).httpTransport;
    expect(transport).toBeTruthy();
    expect(transport.start).toHaveBeenCalled();
    expect(transport.setMessageHandler).toHaveBeenCalledTimes(1);
    expect(typeof transport.setMessageHandler.mock.calls[0]?.[0]).toBe('function');
    expect(transport.onSessionDestroyed).toHaveBeenCalledTimes(1);
    expect(typeof transport.onSessionDestroyed.mock.calls[0]?.[0]).toBe('function');
    expect(transport.config.oauthSessionTimeoutMs).toBe(1234);
    expect(transport.config.oauthRefreshThresholdMs).toBe(567);

    const messageHandler = transport.setMessageHandler.mock.calls[0][0];
    const response = await messageHandler(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
      'session-1'
    );
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 1 });

    const sessionDestroyed = transport.onSessionDestroyed.mock.calls[0][0];
    sessionDestroyed('session-1');
  });

  it('handleJsonRpcMessage routes initialize, tools/call, and other requests', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const server = new MCPServer(logger as any);

    const handleToolCall = vi.fn(async () => ({ ok: 'tool' }));
    const handleOtherRequest = vi.fn(async () => ({ ok: 'other' }));
    (server as any).handleToolCall = handleToolCall;
    (server as any).handleOtherRequest = handleOtherRequest;

    const initResponse = await (server as any).handleJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
      'session-1'
    );

    expect(initResponse).toMatchObject({ jsonrpc: '2.0', id: 1 });

    const toolResponse = await (server as any).handleJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'some_tool', arguments: {} },
      },
      'session-2'
    );
    expect(toolResponse).toEqual({ ok: 'tool' });

    const otherResponse = await (server as any).handleJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {},
      },
      'session-3'
    );
    expect(otherResponse).toEqual({ ok: 'other' });

    expect(handleToolCall).toHaveBeenCalledTimes(1);
    expect(handleOtherRequest).toHaveBeenCalledTimes(1);
  });

  it('runHttp keeps oauth allowed_redirect_hosts undefined when MCP4_ALLOWED_ORIGINS is unset', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const server = new MCPServer(logger as any);
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    await server.initialize(specPath);

    delete process.env.MCP4_ALLOWED_ORIGINS;

    (server as any).profile.interceptors = {
      ...(server as any).profile.interceptors,
      auth: [
        {
          type: 'oauth',
          priority: 1,
          oauth_config: {
            issuer: 'https://issuer.example',
            client_id: 'client-id',
            redirect_uri: 'https://app.example/callback',
          },
        },
      ],
    };

    try {
      await server.runHttp('127.0.0.1', 0);

      const transport = (server as any).httpTransport;
      expect(transport.config.oauthConfig).toBeTruthy();
      expect(transport.config.oauthConfig.allowed_redirect_hosts).toBeUndefined();
    } finally {
      await server.stop();
    }
  });
});
