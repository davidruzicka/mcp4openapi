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

    const server = new MCPServer(logger as any);
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    await server.initialize(specPath);

    delete process.env.MCP4_ALLOWED_ORIGINS;

    await server.runHttp('0.0.0.0', 3003);

    const transport = (server as any).httpTransport;
    expect(transport).toBeTruthy();
    expect(transport.start).toHaveBeenCalled();
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
});
