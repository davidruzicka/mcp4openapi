import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestHttpClient,
  setupFetchMock,
  setupErrorFetchMock,
  setupNetworkErrorFetchMock,
  setupRateLimitFetchMock,
  restoreFetch,
  HttpTestHelper
} from './test-http-utils.js';

// Mock dependencies
vi.mock('../transport/interceptors.js', () => ({
  InterceptorChain: vi.fn().mockImplementation((config) => ({
    config,
  })),
  HttpClient: vi.fn().mockImplementation((baseUrl, interceptors) => ({
    baseUrl,
    interceptors,
    getBaseUrl: () => baseUrl,
    getInterceptorsConfig: () => interceptors.config,
    request: vi.fn().mockImplementation(async (method: string, path: string, options: RequestInit = {}) => {
      const url = `${baseUrl}${path}`;
      const init: RequestInit = {
        method,
        headers: options.headers,
        body: options.body,
      };

      const response = await global.fetch(url, init);
      return {
        status: response.status,
        json: () => response.json(),
      };
    }),
  })),
}));

describe('Test HTTP Utils', () => {
  afterEach(() => {
    restoreFetch();
  });

  describe('createTestHttpClient', () => {
    it('should create client with default parameters', () => {
      const client = createTestHttpClient();
      expect(client.getBaseUrl()).toBe('https://api.example.com');
      expect(client.getInterceptorsConfig()).toEqual({});
    });

    it('should create client with custom parameters', () => {
      const config = { auth: { type: 'bearer' as const, value_from_env: 'TOKEN' } };
      const client = createTestHttpClient('https://custom.com', config);

      expect(client.getBaseUrl()).toBe('https://custom.com');
      expect(client.getInterceptorsConfig()).toBe(config);
    });
  });

  describe('setupFetchMock', () => {
    it('should setup fetch mock with default response', async () => {
      const { capturedHeaders } = setupFetchMock();

      const response = await fetch('https://api.example.com/test', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer token' }
      });

      expect(response.status).toBe(200);
      expect(capturedHeaders['Authorization']).toBe('Bearer token');
      const data = await response.json();
      expect(data).toEqual({ ok: true });
    });

    it('should setup fetch mock with custom response', async () => {
      const customData = { success: true, data: [1, 2, 3] };
      const { capturedHeaders } = setupFetchMock(customData, { status: 201 });

      const response = await fetch('https://api.example.com/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      expect(response.status).toBe(201);
      expect(capturedHeaders['Content-Type']).toBe('application/json');
      const data = await response.json();
      expect(data).toEqual(customData);
    });
  });

  describe('setupErrorFetchMock', () => {
    it('should setup fetch mock that returns error', async () => {
      setupErrorFetchMock(404, 'Not Found');

      const response = await fetch('https://api.example.com/test');
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data).toEqual({ message: 'Not Found' });
    });
  });

  describe('setupNetworkErrorFetchMock', () => {
    it('should setup fetch mock that throws network error', async () => {
      setupNetworkErrorFetchMock();

      await expect(fetch('https://api.example.com/test')).rejects.toThrow('Network error');
    });
  });

  describe('setupRateLimitFetchMock', () => {
    it('should setup fetch mock for rate limiting', async () => {
      setupRateLimitFetchMock();

      const response = await fetch('https://api.example.com/test');
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
    });
  });

  describe('restoreFetch', () => {
    it('should restore original fetch', () => {
      setupFetchMock();
      expect(typeof global.fetch).toBe('function');

      restoreFetch();
      expect(global.fetch).toBeUndefined();
    });
  });

  describe('HttpTestHelper', () => {
    let helper: HttpTestHelper;

    beforeEach(() => {
      helper = new HttpTestHelper();
    });

    afterEach(() => {
      helper.cleanup();
    });

    it('should create client and setup mock', () => {
      const client = helper.getClient();
      expect(client.getBaseUrl()).toBe('https://api.example.com');
    });

    it('should capture headers', async () => {
      await helper.getClient().request('GET', '/test');

      const headers = helper.getCapturedHeaders();
      expect(headers).toBeDefined();
    });

    it('should allow setting custom response', async () => {
      const customData = { custom: 'response' };
      helper.setResponse(customData, { status: 201 });

      const client = helper.getClient();
      const result = await client.request('GET', '/test');

      expect(result.status).toBe(201);
    });

    it('should allow setting error response', async () => {
      helper.setErrorResponse(400, 'Bad Request');

      const client = helper.getClient();
      const result = await client.request('GET', '/test');

      expect(result.status).toBe(400);
    });
  });
});
