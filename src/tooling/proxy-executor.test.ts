import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

import { lookup } from 'node:dns/promises';
import { ProxyDownloadExecutor } from './proxy-executor.js';
import { ValidationError } from '../core/errors.js';
import type { ProxyDownloadOperation } from '../types/profile.js';
import type { AuthCredentials } from '../transport/interceptors.js';
import type { Logger } from '../core/logger.js';

const metadataRequest = (path: string, method: string = 'GET') => ({ path, method });

// Mock logger that satisfies Logger interface
const createMockLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe('ProxyDownloadExecutor', () => {
  const mockHttpClient = {
    request: vi.fn(),
    getBaseUrl: vi.fn(() => 'https://api.example.com'),
  };

  let originalFetch: typeof fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
    mockHttpClient.getBaseUrl.mockReturnValue('https://api.example.com');
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should extract URL from metadata and download content', async () => {
    mockHttpClient.getBaseUrl.mockReturnValue('https://youtrack.cloud');

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
          size: '14',
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

  it('should throw when direct download metadata size exceeds max', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        id: 1234,
        artifacts_file: {
          filename: 'job-artifacts.txt',
          size: 200,
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
      max_size_bytes: 100,
    };

    await expect(
      executor.execute(
        operation,
        metadataRequest('/projects/1/jobs/1234'),
        { headers: { Authorization: 'Bearer token' } },
        { path: '/projects/1/jobs/1234/artifacts', method: 'GET' }
      )
    ).rejects.toThrow('exceeds maximum');
  });

  it('should use absolute download endpoint without prefixing base URL', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { id: 1234 },
    });

    const mockBinary = new Uint8Array([0x01, 0x02]);
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
      skip_auth: true,
    };

    await executor.execute(
      operation,
      metadataRequest('/projects/1/jobs/1234'),
      { headers: { Authorization: 'Bearer token' } },
      { path: 'https://cdn.example.com/artifacts/1234', method: 'GET' }
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://cdn.example.com/artifacts/1234',
      expect.objectContaining({ method: 'GET', headers: {} })
    );
  });

  it('should reject cross-origin authenticated downloads', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://cdn.example.com/files/abc123',
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/issues/{id}/attachments/{attachmentId}',
    };

    await expect(
      executor.execute(
        operation,
        metadataRequest('/issues/PROJ-1/attachments/att-123'),
        { headers: { Authorization: 'Bearer token' } }
      )
    ).rejects.toThrow('Cross-origin download URL not allowed');
  });

  it('should reject cross-origin redirects when skip_auth is false', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://api.example.com/download/123' },
    });

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://cdn.example.com/artifacts/123' }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), {
        headers: { Authorization: 'Bearer token' },
      })
    ).rejects.toThrow('Cross-origin download URL not allowed');
  });

  it('should follow cross-origin redirects when skip_auth is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://api.example.com/download/123' },
    });

    const mockBinary = new Uint8Array([0x01, 0x02]);
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://cdn.example.com/artifacts/123' }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(mockBinary.byteLength),
          'content-type': 'application/octet-stream',
        }),
        arrayBuffer: () => Promise.resolve(mockBinary.buffer),
      });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await executor.execute(operation, metadataRequest('/file'), {
      headers: { Authorization: 'Bearer token' },
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://api.example.com/download/123',
      expect.objectContaining({
        headers: {},
        redirect: 'manual',
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://cdn.example.com/artifacts/123',
      expect.objectContaining({
        headers: {},
        redirect: 'manual',
      })
    );
  });

  it('should allow only allowed_hosts when skip_auth is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://cdn.example.com/files/abc123' },
    });

    const mockBinary = new Uint8Array([0x01, 0x02]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(mockBinary.byteLength),
        'content-type': 'application/octet-stream',
      }),
      arrayBuffer: () => Promise.resolve(mockBinary.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      allowed_hosts: ['cdn.example.com'],
    };

    await executor.execute(operation, metadataRequest('/file'), { headers: {} });
  });

  it('should reject non-allowed_hosts when skip_auth is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://cdn.example.com/files/abc123' },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      allowed_hosts: ['other.example.com'],
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('Host not in allowlist');
  });

  it('should log allowlist details when host is not allowed', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://cdn.example.com/files/abc123' },
    });

    const logger = createMockLogger();
    const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      allowed_hosts: ['other.example.com'],
    };

    await expect(executor.execute(operation, metadataRequest('/file'), { headers: {} })).rejects.toThrow(
      'Host not in allowlist'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'SSRF blocked: host not in allowlist',
      expect.objectContaining({
        hostname: 'cdn.example.com',
        allowed_hosts: ['other.example.com'],
      })
    );
  });

  it('should reject private network targets by default when skip_auth is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'http://127.0.0.1/secret' },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('IP address not allowed');
  });

  it('should log blocked IPv4 targets when allow_private_network is false', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'http://10.0.0.1/secret' },
    });

    const logger = createMockLogger();
    const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await expect(executor.execute(operation, metadataRequest('/file'), { headers: {} })).rejects.toThrow(
      'IP address not allowed'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'SSRF blocked: private/loopback/link-local IPv4 target',
      expect.objectContaining({
        hostname: '10.0.0.1',
      })
    );
  });

  it('should log blocked IPv6 targets when allow_private_network is false', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'http://[::1]/secret' },
    });

    const logger = createMockLogger();
    const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await expect(executor.execute(operation, metadataRequest('/file'), { headers: {} })).rejects.toThrow(
      'IP address not allowed'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'SSRF blocked: private/loopback/link-local IPv6 target',
      expect.objectContaining({
        hostname: '::1',
      })
    );
  });

  it('should allow private network targets when allow_private_network is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'http://127.0.0.1/secret' },
    });

    const mockBinary = new Uint8Array([0x01]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(mockBinary.byteLength),
        'content-type': 'application/octet-stream',
      }),
      arrayBuffer: () => Promise.resolve(mockBinary.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      allow_private_network: true,
    };

    await executor.execute(operation, metadataRequest('/file'), { headers: {} });
  });

  it('should reject hostname that resolves to private IP when skip_auth is true', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as any);

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://internal.example.com/files/abc123' },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('Hostname resolves to disallowed IP');
  });

  it('should log hostname resolution details when hostname resolves to disallowed IP', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as any);

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://internal.example.com/files/abc123' },
    });

    const logger = createMockLogger();
    const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await expect(executor.execute(operation, metadataRequest('/file'), { headers: {} })).rejects.toThrow(
      'Hostname resolves to disallowed IP'
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'SSRF blocked: hostname resolves to private/loopback/link-local IP',
      expect.objectContaining({
        hostname: 'internal.example.com',
        resolved_addresses: ['10.0.0.1'],
      })
    );
  });

  it('should reject hostnames when DNS lookup fails', async () => {
    vi.mocked(lookup).mockRejectedValue(new Error('dns failure'));

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://internal.example.com/files/abc123' },
    });

    const logger = createMockLogger();
    const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('DNS lookup failed');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should reject redirects without Location header', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://cdn.example.com/download/123' },
    });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Headers(),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      allowed_hosts: ['cdn.example.com'],
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('Redirect without Location header');
  });

  it('should stop after too many redirects', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://cdn.example.com/download/123' },
    });

    const fetchMock = vi.fn();
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'https://cdn.example.com/download/123' }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    }
    global.fetch = fetchMock;

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      allowed_hosts: ['cdn.example.com'],
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('Too many redirects');
  });

  it('should allow hostname that resolves to private IP when allow_private_network is true', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as any);

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://internal.example.com/files/abc123' },
    });

    const mockBinary = new Uint8Array([0x01]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-length': String(mockBinary.byteLength),
        'content-type': 'application/octet-stream',
      }),
      arrayBuffer: () => Promise.resolve(mockBinary.buffer),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      skip_auth: true,
      allow_private_network: true,
    };

    await executor.execute(operation, metadataRequest('/file'), { headers: {} });
  });

  it('should reject redirects to localhost or private IPs', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://api.example.com/download/123' },
    });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://127.0.0.1/secret' }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), {
        headers: { Authorization: 'Bearer token' },
      })
    ).rejects.toThrow(ValidationError);
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
        url: 'https://api.example.com/file',
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
        url: 'https://api.example.com/file',
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
          downloadUrl: 'https://api.example.com/download/abc',
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
      'https://api.example.com/download/abc',
      expect.any(Object)
    );
  });

  it('should return undefined for unsafe nested path segments', () => {
    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const metadata = {
      metadata: {
        downloadUrl: 'https://api.example.com/download/abc',
      },
    };

    const value = (executor as any).extractNestedValue(metadata, '__proto__.downloadUrl');

    expect(value).toBeUndefined();
  });

  it('should reject unsafe url_field path segments', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        metadata: {
          downloadUrl: 'https://api.example.com/download/abc',
        },
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/attachments/{id}',
      url_field: '__proto__.downloadUrl',
    };

    await expect(
      executor.execute(operation, metadataRequest('/attachments/456'), { headers: {} })
    ).rejects.toThrow("URL field '__proto__.downloadUrl' not found in metadata response");
  });

  it('should handle download timeout', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://api.example.com/large-file',
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
      executor.execute(operation, metadataRequest('/attachments/123'), { headers: {} })
    ).rejects.toThrow();
  }, 2000);

  it('should download content from data URL', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'data:text/plain;base64,SGVsbG8=',
        mimeType: 'text/plain',
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
    };

    const result = await executor.execute(
      operation,
      metadataRequest('/file'),
      { headers: {} }
    );

    expect(result.content).toBe('SGVsbG8=');
    expect(result.mimeType).toBe('text/plain');
    expect(result.size).toBe(Buffer.from('Hello').length);
  });

  it('should use default url_field when not specified', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'https://api.example.com/file',
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

  it('should reject unsupported data URL format', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'data:text/plain,Hello',
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
    ).rejects.toThrow('Unsupported data URL format');
  });

  it('should enforce max size for data URLs', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        url: 'data:text/plain;base64,QUJDRA==', // ABCD
      },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    const operation: ProxyDownloadOperation = {
      type: 'proxy_download',
      metadata_endpoint: 'get_/file',
      url_field: 'url',
      max_size_bytes: 3,
    };

    await expect(
      executor.execute(operation, metadataRequest('/file'), { headers: {} })
    ).rejects.toThrow('Downloaded file size 4 exceeds maximum 3 bytes');
  });

  it('should throw on invalid API base URL when deriving base origin', async () => {
    mockHttpClient.getBaseUrl.mockReturnValue('not-a-url');

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    await expect(
      executor.execute(
        { type: 'proxy_download', metadata_endpoint: 'get_/file' },
        metadataRequest('/file'),
        { headers: {} }
      )
    ).rejects.toThrow('Invalid API base URL - expected absolute http(s) URL');
  });

  it('should reject unsupported download URL scheme', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'file:///etc/passwd' },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    await expect(
      executor.execute(
        { type: 'proxy_download', metadata_endpoint: 'get_/file', url_field: 'url' },
        metadataRequest('/file'),
        { headers: {} }
      )
    ).rejects.toThrow("Unsupported download URL scheme: 'file:'");
  });

  it('should reject unsupported API base URL scheme when resolving relative downloads', async () => {
    mockHttpClient.getBaseUrl.mockReturnValue('ftp://api.example.com');
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: '/download/123' },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    await expect(
      executor.execute(
        { type: 'proxy_download', metadata_endpoint: 'get_/file', url_field: 'url' },
        metadataRequest('/file'),
        { headers: {} }
      )
    ).rejects.toThrow("Unsupported API base URL scheme: 'ftp:'");
  });

  it('should reject invalid redirect URL', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://api.example.com/download/123' },
    });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://[::1' }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    await expect(
      executor.execute(
        {
          type: 'proxy_download',
          metadata_endpoint: 'get_/file',
          url_field: 'url',
          skip_auth: true,
          allowed_hosts: ['api.example.com'],
        },
        metadataRequest('/file'),
        { headers: {} }
      )
    ).rejects.toThrow("Invalid redirect URL: 'http://[::1'");
  });

  it('should block localhost targets when skip_auth is true', async () => {
    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'http://localhost/secret' },
    });

    const logger = createMockLogger();
    const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);
    await expect(
      executor.execute(
        { type: 'proxy_download', metadata_endpoint: 'get_/file', url_field: 'url', skip_auth: true },
        metadataRequest('/file'),
        { headers: {} }
      )
    ).rejects.toThrow('Hostname not allowed (localhost)');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should block hostname resolving to IPv6 loopback when skip_auth is true', async () => {
    vi.mocked(lookup).mockResolvedValue([{ address: '::1', family: 6 }] as any);

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://internal.example.com/secret' },
    });

    const executor = new ProxyDownloadExecutor(mockHttpClient as any);
    await expect(
      executor.execute(
        { type: 'proxy_download', metadata_endpoint: 'get_/file', url_field: 'url', skip_auth: true },
        metadataRequest('/file'),
        { headers: {} }
      )
    ).rejects.toThrow('Hostname resolves to disallowed IP');
  });

  it('should reject hostnames when DNS lookup returns no addresses', async () => {
    vi.mocked(lookup).mockResolvedValue([] as any);

    mockHttpClient.request.mockResolvedValue({
      status: 200,
      headers: {},
      body: { url: 'https://internal.example.com/files/abc123' },
    });

    const logger = createMockLogger();
    const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);
    await expect(
      executor.execute(
        {
          type: 'proxy_download',
          metadata_endpoint: 'get_/file',
          url_field: 'url',
          skip_auth: true,
        },
        metadataRequest('/file'),
        { headers: {} }
      )
    ).rejects.toThrow('DNS lookup returned no addresses');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should reject hostnames when DNS lookup times out', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(lookup).mockImplementation(() => new Promise(() => {}) as any);

      mockHttpClient.request.mockResolvedValue({
        status: 200,
        headers: {},
        body: { url: 'https://internal.example.com/files/abc123' },
      });

      const logger = createMockLogger();
      const executor = new ProxyDownloadExecutor(mockHttpClient as any, logger);

      const promise = executor.execute(
        {
          type: 'proxy_download',
          metadata_endpoint: 'get_/file',
          url_field: 'url',
          skip_auth: true,
        },
        metadataRequest('/file'),
        { headers: {} }
      );

      const assertion = expect(promise).rejects.toThrow('DNS lookup failed for hostname');
      await vi.advanceTimersByTimeAsync(2100);
      await assertion;
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
      vi.useRealTimers();
    }
  });
});
