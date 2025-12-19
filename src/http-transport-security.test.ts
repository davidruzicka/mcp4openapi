import { describe, it, expect, vi } from 'vitest';
import type { McpRequest } from './types/http-transport.js';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';

function createMockResponse() {
  const res: any = {
    headersSent: false,
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader: vi.fn((key: string, value: string) => {
      res.headers[key.toLowerCase()] = value;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    send: vi.fn((body?: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn(() => {
      res.headersSent = true;
    }),
    get: vi.fn(() => undefined),
  };
  return res;
}

describe('HttpTransport security behavior (no listen)', () => {
  it('returns 400 for invalid Authorization header format (no 500 leak)', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      },
      new ConsoleLogger()
    );
    transport.setMessageHandler(async () => ({ result: 'ok' }));

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: {
        accept: 'application/json',
        authorization: 'NotBearer abc',
        host: 'localhost',
      } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toHaveProperty('error', 'Bad Request');
    expect(res.body).toHaveProperty('correlationId');
    await transport.stop();
  });

  it('returns 500 with correlation ID and hides internal message', async () => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      },
      new ConsoleLogger()
    );
    transport.setMessageHandler(async () => {
      throw new Error('Sensitive internal failure');
    });

    const req: McpRequest = {
      method: 'POST',
      path: '/mcp',
      url: '/mcp',
      headers: {
        accept: 'application/json',
        host: 'localhost',
      } as any,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    } as any;

    const res = createMockResponse();
    await (transport as any).handlePost(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toHaveProperty('error', 'Internal Server Error');
    expect(res.body).toHaveProperty('correlationId');
    expect(String(res.body.message)).toContain('correlation ID');
    expect(String(res.body.message)).not.toContain('Sensitive internal failure');
    await transport.stop();
  });
});

