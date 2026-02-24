
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyDownloadExecutor } from './proxy-executor.js';
import { ValidationError } from '../core/errors.js';

describe('ProxyDownloadExecutor Security', () => {
  const mockHttpClient = {
    request: vi.fn(),
    getBaseUrl: vi.fn().mockReturnValue('http://api.example.com'),
  };

  const executor = new ProxyDownloadExecutor(mockHttpClient as any);

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.TEST_SECRET = 'secret-value-123';
  });

  afterEach(() => {
    delete process.env.TEST_SECRET;
  });

  it('should not leak environment variable values in error messages', async () => {
    const operation = {
      name: 'test-download',
      type: 'proxy-download' as const,
      max_size_bytes_from_env: 'TEST_SECRET',
    };

    const metadataRequest = {
        path: '/files/123',
        method: 'GET'
    };

    mockHttpClient.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: { url: 'http://example.com/file.txt' }
    });

    try {
      await executor.execute(operation, metadataRequest, { headers: {} });
      expect.fail('Should have thrown ValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const message = (error as Error).message;
      // The error message SHOULD NOT contain the secret value
      expect(message).not.toContain('secret-value-123');
      expect(message).toContain('Invalid max size from env TEST_SECRET');
    }
  });
});
