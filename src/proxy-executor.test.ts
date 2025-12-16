import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyDownloadExecutor } from './proxy-executor.js';
import { ValidationError } from './errors.js';
import type { ProxyDownloadOperation } from './types/profile.js';
import type { AuthCredentials } from './interceptors.js';

const metadataRequest = (path: string, method: string = 'GET') => ({ path, method });

describe('ProxyDownloadExecutor', () => {
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
      metadataRequest('/issues/PROJ-1/attachments/att-123'),
      { headers: { Authorization: 'Bearer token' } }
    );

    expect(result.mimeType).toBe('image/jpeg');
    expect(result.fileName).toBe('photo.jpg');
    expect(result.content).toBeDefined();
    expect(result.size).toBe(mockBlob.byteLength);
    expect(result.metadata.id).toBe('att-123');
  });

  it('should download directly when download_endpoint is provided', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 1234,
        artifacts_file: {
          filename: 'job-artifacts.txt',
          size: 14,
        },
      },
    });

    const mockBinary = new TextEncoder().encode('artifact data\n');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-length': String(mockBinary.byteLength),
        'content-type': 'application/octet-stream',
      }),
      arrayBuffer: () => Promise.resolve(mockBinary.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'getApiV4ProjectsIdJobsJobId',
      download_endpoint: 'getApiV4ProjectsIdJobsJobIdArtifacts',
    };

    const result = await executor.execute(
      operation,
      metadataRequest('/projects/1/jobs/1234'),
      { headers: { Authorization: 'Bearer job-token' } },
      { path: '/projects/1/jobs/1234/artifacts', method: 'GET' }
    );

    expect(result.size).toBe(mockBinary.byteLength);
    expect(result.fileName).toBe('job-artifacts.txt');
    expect(result.mimeType).toBe('application/octet-stream');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/projects/1/jobs/1234/artifacts',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer job-token' },
      })
    );
  });

  it('should enforce MIME whitelist for direct download responses', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 1234,
        artifacts_file: {
          filename: 'job-artifacts.zip',
          size: 1024,
        },
      },
    });

    const mockBinary = new Uint8Array([0x00, 0x01]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-length': String(mockBinary.byteLength),
        'content-type': 'application/zip',
      }),
      arrayBuffer: () => Promise.resolve(mockBinary.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'getApiV4ProjectsIdJobsJobId',
      download_endpoint: 'getApiV4ProjectsIdJobsJobIdArtifacts',
      allowed_mime_types: ['application/pdf'],
    };

    await expect(
      executor.execute(
        operation,
        metadataRequest('/projects/1/jobs/1234'),
        { headers: { Authorization: 'Bearer job-token' } },
        { path: '/projects/1/jobs/1234/artifacts', method: 'GET' }
      )
    ).rejects.toThrow(
      "MIME type 'application/zip' not in whitelist: application/pdf"
    );
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
      executor.execute(operation, metadataRequest('/attachments/123'), { headers: {} })
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
      executor.execute(operation, metadataRequest('/attachments/123'), { headers: {} })
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
      metadataRequest('/attachments/456'),
      { headers: {} }
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
      executor.execute(operation, metadataRequest('/attachments/123'), {})
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

    const result = await executor.execute(
      operation,
      metadataRequest('/attachments/123'),
      { headers: {} }
    );

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
      executor.execute(operation, metadataRequest('/attachments/789'), { headers: {} })
    ).rejects.toThrow('not found in metadata');
  });
});

describe('ProxyDownloadExecutor - Auth Credentials', () => {
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

  it('should apply bearer token in headers', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedInit: RequestInit | undefined;
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((_url: any, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    const authCredentials: AuthCredentials = {
      headers: { Authorization: 'Bearer my-token' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    expect(capturedInit?.headers).toEqual({ Authorization: 'Bearer my-token' });
  });

  it('should apply custom header auth', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedInit: RequestInit | undefined;
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((_url: any, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    const authCredentials: AuthCredentials = {
      headers: { 'X-API-Key': 'my-api-key' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    expect(capturedInit?.headers).toEqual({ 'X-API-Key': 'my-api-key' });
  });

  it('should add query auth param to URL if not present', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file?version=1',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedUrl: string = '';
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((url: any) => {
      capturedUrl = url.toString();
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    const authCredentials: AuthCredentials = {
      headers: {},
      queryParams: { key: 'token', value: 'abc123' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    expect(capturedUrl).toContain('token=abc123');
    expect(capturedUrl).toContain('version=1'); // Original param preserved
  });

  it('should NOT add query auth param if already present in URL', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file?token=existing-token&version=1',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedUrl: string = '';
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((url: any) => {
      capturedUrl = url.toString();
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    const authCredentials: AuthCredentials = {
      headers: {},
      queryParams: { key: 'token', value: 'new-token' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    // Should keep existing token, not add new one
    expect(capturedUrl).toContain('token=existing-token');
    expect(capturedUrl).not.toContain('token=new-token');
  });

  it('should work with both bearer header and query auth (bearer takes precedence in headers)', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedUrl: string = '';
    let capturedInit: RequestInit | undefined;
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((url: any, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    const authCredentials: AuthCredentials = {
      headers: { Authorization: 'Bearer my-token' },
      queryParams: { key: 'api_key', value: 'should-not-be-used' },
    };

    // In reality, InterceptorChain would only return one auth type
    // But if both are provided, should use headers
    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    expect(capturedInit?.headers).toEqual({ Authorization: 'Bearer my-token' });
    // Query param would still be added if provided
    expect(capturedUrl).toContain('api_key=should-not-be-used');
  });
});

describe('ProxyDownloadExecutor - skip_auth option', () => {
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

  it('should skip auth headers when skip_auth is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://s3.amazonaws.com/bucket/file?X-Amz-Signature=abc123',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedInit: RequestInit | undefined;
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((_url: any, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    const authCredentials: AuthCredentials = {
      headers: { Authorization: 'Bearer should-not-be-used' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    // Auth headers should NOT be sent
    expect(capturedInit?.headers).toEqual({});
  });

  it('should skip query auth params when skip_auth is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedUrl: string = '';
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((url: any) => {
      capturedUrl = url.toString();
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    const authCredentials: AuthCredentials = {
      headers: {},
      queryParams: { key: 'token', value: 'should-not-be-added' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    // Query auth param should NOT be added
    expect(capturedUrl).not.toContain('token=');
    expect(capturedUrl).toBe('https://example.com/file');
  });

  it('should still authenticate metadata endpoint when skip_auth is true', async () => {
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://public.example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '3' }),
      arrayBuffer: () => Promise.resolve(mockBlob.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await executor.execute(operation, metadataRequest('/file'), { headers: { Authorization: 'Bearer token' } });

    // Metadata endpoint should still be authenticated via httpClient.request()
    expect(mockHttpClient.request).toHaveBeenCalledWith('GET', '/file');
  });

  it('should default to skip_auth=false when not specified', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedInit: RequestInit | undefined;
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((_url: any, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      // skip_auth not specified, should default to false
    };

    const authCredentials: AuthCredentials = {
      headers: { Authorization: 'Bearer token' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    // Auth headers should be sent (default behavior)
    expect(capturedInit?.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('should work with pre-signed S3 URLs', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://my-bucket.s3.amazonaws.com/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE&X-Amz-Expires=3600&X-Amz-Signature=abc123def456',
        mimeType: 'application/pdf',
      },
    });

    let capturedUrl: string = '';
    let capturedInit: RequestInit | undefined;
    const mockBlob = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // PDF header
    global.fetch = vi.fn().mockImplementation((url: any, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '4' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    const authCredentials: AuthCredentials = {
      headers: { Authorization: 'Bearer api-token' },
      queryParams: { key: 'api_key', value: 'secret' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    // S3 URL should be unchanged (no auth added)
    expect(capturedUrl).toContain('X-Amz-Signature=abc123def456');
    expect(capturedUrl).not.toContain('api_key');
    expect(capturedInit?.headers).toEqual({});
  });

  it('should work with skip_auth=false to require auth', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    let capturedInit: RequestInit | undefined;
    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockImplementation((_url: any, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-length': '3' }),
        arrayBuffer: () => Promise.resolve(mockBlob.buffer),
      });
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: false,
    };

    const authCredentials: AuthCredentials = {
      headers: { Authorization: 'Bearer token' },
    };

    await executor.execute(operation, metadataRequest('/file'), authCredentials);

    // Auth headers should be sent
    expect(capturedInit?.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('should handle HTTP error responses from download', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    const mockBlob = new Uint8Array([0x01, 0x02, 0x03]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'content-length': '3' }),
      arrayBuffer: () => Promise.resolve(mockBlob.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('Download failed: HTTP 403');
  });

  it('should reject downloads with content-length exceeding maxSize', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/large-file',
        mimeType: 'application/octet-stream',
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '100000000' }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100000000)),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      max_size_bytes: 50000000,
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('exceeds maximum');
  });

  it('should reject downloads with actual size exceeding maxSize', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    // Return a file larger than max size
    const largeBuffer = new ArrayBuffer(100000000);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({}),
      arrayBuffer: () => Promise.resolve(largeBuffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      max_size_bytes: 50000000,
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('exceeds maximum');
  });

  it('should handle nested URL field path with missing intermediate object', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 'att-999',
        // missing 'metadata' object, so path 'metadata.url' should fail
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'metadata.url',
    };

    await expect(
      executor.execute(operation, metadataRequest('/attachments/999'), { headers: {} })
    ).rejects.toThrow('not found in metadata');
  });

  it('should handle URL field that is not a string', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 'att-888',
        url: 12345, // URL is a number, not a string
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'url',
    };

    await expect(
      executor.execute(operation, metadataRequest('/attachments/888'), { headers: {} })
    ).rejects.toThrow('not found in metadata');
  });

  it('should reject MIME type not in whitelist', async () => {
    // Mock metadata response with non-whitelisted MIME type
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 'att-123',
        name: 'script.exe',
        url: 'https://youtrack.cloud/api/files/abc123',
        mimeType: 'application/x-msdownload',
        size: 1024,
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: 'url',
      allowed_mime_types: ['image/jpeg', 'image/png', 'application/pdf'],
    };

    await expect(
      executor.execute(operation, metadataRequest('/attachments/123'), { headers: {} })
    ).rejects.toThrow(
      "MIME type 'application/x-msdownload' not in whitelist: image/jpeg, image/png, application/pdf"
    );
  });
});

describe('ProxyDownloadExecutor - env overrides', () => {
  const mockHttpClient = { request: vi.fn(), getBaseUrl: vi.fn(() => 'https://api.example.com') };
  let originalFetch: typeof fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpClient.getBaseUrl.mockReturnValue('https://api.example.com');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('should honor env override when enforcing size', async () => {
    process.env.MCP4_PROXY_MAX_BYTES = '2048';

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    const oversizedBuffer = new ArrayBuffer(4096);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '4096' }),
      arrayBuffer: () => Promise.resolve(oversizedBuffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      max_size_bytes_from_env: 'MCP4_PROXY_MAX_BYTES',
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('should throw ValidationError for invalid env override value', async () => {
    process.env.MCP4_PROXY_MAX_BYTES = 'abc';

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('should fall back to operation max_size_bytes when env override is absent', async () => {
    delete process.env.MCP4_PROXY_MAX_BYTES;

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://example.com/file',
        mimeType: 'application/octet-stream',
      },
    });

    const oversizedBuffer = new ArrayBuffer(8192);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({}),
      arrayBuffer: () => Promise.resolve(oversizedBuffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      max_size_bytes: 4096,
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('exceeds maximum');
  });
});
