import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lookup } from 'node:dns/promises';
import { ProxyDownloadExecutor } from './proxy-executor.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

describe('ProxyDownloadExecutor Security Bypass', () => {
  const mockHttpClient = {
    request: vi.fn(),
    getBaseUrl: vi.fn(() => 'https://api.example.com'),
  };

  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpClient.getBaseUrl.mockReturnValue('https://api.example.com');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should REJECT IPv4-mapped IPv6 localhost address when skip_auth is true', async () => {
    // This resolves to ::ffff:127.0.0.1 which is localhost
    vi.mocked(lookup).mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }] as any);

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://ipv4mapped.example.com/secret' },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: any = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      // allow_private_network defaults to false
    };

    // Mock fetch to succeed if called (demonstrating bypass)
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '5' }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('data').buffer),
    });

    // This previously FAILED to throw (bypass), so the promise resolved successfully.
    // Now fixed, it should throw 'Hostname resolves to disallowed IP' from SSRFValidator.
    await expect(
      executor.execute(operation, { path: '/file', method: 'GET' }, { headers: {} })
    ).rejects.toThrow('Hostname resolves to disallowed IP');
  });
});
