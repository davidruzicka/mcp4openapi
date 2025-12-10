import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyDownloadExecutor } from './proxy-executor.js';
import type { ProxyDownloadOperation } from './types/profile.js';

describe('ProxyDownloadExecutor', () => {
  const mockHttpClient = {
    request: vi.fn(),
  };

  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should extract URL from metadata and download content', async () => {
    // Mock metadata response
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 'att-123',
        name: 'photo.jpg',
        url: 'https://youtrack.cloud/api/files/abc123',
        mimeType: 'image/jpeg',
        size: 1024,
      },
    });

    // Mock file download
    const mockBlob = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      arrayBuffer: () => Promise.resolve(mockBlob.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/issues/{id}/attachments/{attachmentId}',
      url_field: 'url',
    };

    const result = await executor.execute(
      operation,
      '/issues/PROJ-1/attachments/att-123',
      { Authorization: 'Bearer token' }
    );

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.fileName).toBe('photo.jpg');
    expect(result.content).toBeDefined();
    expect(result.size).toBe(mockBlob.byteLength);
    expect(result.metadata.id).toBe('att-123');
  });

  it('should reject files exceeding max size', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        size: 20000000,
        mimeType: 'application/octet-stream',
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'url',
      max_size_bytes: 10000000,
    };

    await expect(
      executor.execute(operation, '/attachments/123', {})
    ).rejects.toThrow('exceeds maximum');
  });

  it('should enforce MIME type whitelist', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/exe',
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'url',
      allowed_mime_types: ['image/*', 'application/pdf'],
    };

    await expect(
      executor.execute(operation, '/attachments/123', {})
    ).rejects.toThrow('not in whitelist');
  });

  it('should support nested url_field with dot notation', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 'att-456',
        metadata: {
          downloadUrl: 'https://example.com/download/abc',
          fileName: 'document.pdf',
        },
        mimeType: 'application/pdf',
      },
    });

    const mockBlob = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // PDF header
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '4' }),
      arrayBuffer: () => Promise.resolve(mockBlob.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'metadata.downloadUrl',
    };

    const result = await executor.execute(
      operation,
      '/attachments/456',
      {}
    );

    expect(result.mimeType).toBe('application/pdf');
    expect(result.size).toBe(mockBlob.byteLength);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.com/download/abc',
      expect.any(Object)
    );
  });

  it('should handle download timeout', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/large-file',
        mimeType: 'application/octet-stream',
      },
    });

    // Mock fetch that immediately throws abort error
    global.fetch = vi.fn(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError')));

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'url',
      timeout_ms: 100,
    };

    await expect(
      executor.execute(operation, '/attachments/123', {})
    ).rejects.toThrow();
  }, 2000);

  it('should use default url_field when not specified', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'text/plain',
      },
    });

    const mockBlob = new Uint8Array([0x48, 0x69]); // "Hi"
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '2' }),
      arrayBuffer: () => Promise.resolve(mockBlob.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      // url_field omitted, should default to 'url'
    };

    const result = await executor.execute(operation, '/attachments/123', {});

    expect(result.content).toBeDefined();
    expect(result.mimeType).toBe('text/plain');
    expect(result.size).toBe(mockBlob.byteLength);
  });

  it('should throw when URL field not found in metadata', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 'att-789',
        name: 'file.txt',
        // no 'url' field
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'url',
    };

    await expect(
      executor.execute(operation, '/attachments/789', {})
    ).rejects.toThrow('not found in metadata');
  });
});
