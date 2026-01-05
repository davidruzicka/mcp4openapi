import { describe, it, expect, vi } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';
import type { McpRequest } from './types/http-transport.js';

function createTransport(config?: Partial<any>) {
  return new HttpTransport(
    {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
      ...config,
    } as any,
    new ConsoleLogger()
  );
}

function createMockResponse(onEnd?: () => void) {
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
      if (onEnd) onEnd();
      return res;
    }),
    send: vi.fn((body?: unknown) => {
      res.body = body;
      res.headersSent = true;
      if (onEnd) onEnd();
      return res;
    }),
    end: vi.fn(() => {
      res.headersSent = true;
      if (onEnd) onEnd();
    }),
    get: vi.fn((key: string) => res.headers[key.toLowerCase()]),
  };
  return res;
}

describe('HttpTransport Security Headers', () => {
  it('should set general security headers but skip HSTS on localhost', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    // Express populates req.hostname based on Host header
    // We need to simulate express request behavior or provide hostname
    const req: any = {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'localhost',
        origin: 'http://localhost',
        accept: 'application/json'
      },
      hostname: 'localhost', // Explicitly set as mock express req
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      socket: { remoteAddress: '127.0.0.1' },
      get: (header: string) => req.headers[header]
    };

    await new Promise<void>((resolve) => {
        const res = createMockResponse(() => resolve());
        transport.setMessageHandler(async () => ({ result: 'ok' }));
        app(req, res, (err: any) => { if (err) console.error(err); resolve(); });
        (req as any)._res = res;
    });

    const res = (req as any)._res;

    // Standard headers should be present
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");

    // HSTS should NOT be present for localhost
    expect(res.headers['strict-transport-security']).toBeUndefined();

    await transport.stop();
  });

  it('should set HSTS on non-localhost domain', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const req: any = {
      method: 'POST',
      url: '/mcp',
      headers: {
        host: 'example.com',
        origin: 'https://example.com',
        accept: 'application/json'
      },
      hostname: 'example.com', // Mocking express behavior
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      socket: { remoteAddress: '93.184.216.34' },
      get: (header: string) => req.headers[header]
    };

    await new Promise<void>((resolve) => {
        const res = createMockResponse(() => resolve());
        transport.setMessageHandler(async () => ({ result: 'ok' }));
        app(req, res, (err: any) => { if (err) console.error(err); resolve(); });
        (req as any)._res = res;
    });

    const res = (req as any)._res;

    // HSTS SHOULD be present for production domain
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');

    await transport.stop();
  });

  it('should skip HSTS for Let\'s Encrypt challenge paths', async () => {
    const transport = createTransport();
    const app = (transport as any).app;

    const req: any = {
      method: 'GET',
      url: '/.well-known/acme-challenge/test-token',
      headers: {
        host: 'example.com',
        origin: 'http://example.com'
      },
      hostname: 'example.com',
      socket: { remoteAddress: '93.184.216.34' },
      get: (header: string) => req.headers[header]
    };

    await new Promise<void>((resolve) => {
        const res = createMockResponse(() => resolve());
        // No message handler needed as middleware runs before routing
        app(req, res, (err: any) => { if (err) console.error(err); resolve(); });
        (req as any)._res = res;
    });

    const res = (req as any)._res;

    // HSTS should NOT be present for ACME challenge
    expect(res.headers['strict-transport-security']).toBeUndefined();
    // Other headers should still be present
    expect(res.headers['x-content-type-options']).toBe('nosniff');

    await transport.stop();
  });
});
