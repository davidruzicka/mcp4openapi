/**
 * Test utilities for HTTP client setup and mocking
 *
 * Why: Eliminates code duplication in HTTP client test setup
 * Provides consistent mocking and client creation patterns
 */

import { HttpClient, InterceptorChain } from '../transport/interceptors.js';
import type { InterceptorConfig } from '../types/profile.js';
import type { Logger } from '../core/logger.js';
import { SSRFValidator } from '../security/ssrf-validator.js';

// Request input type for fetch mocking
type RequestInput = any;

// Mock logger to suppress output during tests
const mockLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Mock SSRF validator that allows everything
const mockSSRFValidator = {
  validate: async () => {},
} as unknown as SSRFValidator;

/**
 * Create HTTP client with interceptors for testing
 */
export function createTestHttpClient(
  baseUrl: RequestInput = 'https://api.example.com',
  interceptors: InterceptorConfig = {}
): HttpClient {
  const interceptorChain = new InterceptorChain(interceptors);
  return new HttpClient(baseUrl, interceptorChain, null, mockLogger, mockSSRFValidator);
}

/**
 * Setup fetch mock that captures request headers
 */
export function setupFetchMock(
  responseBody: any = { ok: true },
  responseOptions: ResponseInit = { status: 200, headers: { 'Content-Type': 'application/json' } }
): { capturedHeaders: Record<RequestInput, RequestInput> } {
  const capturedHeaders: Record<RequestInput, RequestInput> = {};

  global.fetch = async (url: RequestInput | URL, init?: RequestInit) => {
    // Copy headers to the shared object
    Object.assign(capturedHeaders, init?.headers as Record<RequestInput, RequestInput> || {});
    return new Response(JSON.stringify(responseBody), responseOptions);
  };

  return { capturedHeaders };
}

/**
 * Setup fetch mock that returns error response
 */
export function setupErrorFetchMock(status: number = 500, message: RequestInput = 'Internal Server Error'): void {
  global.fetch = async () => new Response(JSON.stringify({ message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Setup fetch mock for network errors
 */
export function setupNetworkErrorFetchMock(): void {
  global.fetch = async () => {
    throw new Error('Network error');
  };
}

/**
 * Setup fetch mock for rate limiting
 */
export function setupRateLimitFetchMock(): void {
  global.fetch = async () => new Response(null, {
    status: 429,
    headers: { 'Retry-After': '60' }
  });
}

/**
 * Restore original fetch
 */
export function restoreFetch(): void {
  delete (global as any).fetch;
}

/**
 * Test helper for HTTP client tests
 */
export class HttpTestHelper {
  private capturedHeaders: Record<RequestInput, RequestInput> = {};

  constructor(
    private baseUrl: RequestInput = 'https://api.example.com',
    private interceptors: InterceptorConfig = {}
  ) {
    this.setupMock();
  }

  private setupMock(): void {
    global.fetch = async (url: RequestInput | URL, init?: RequestInit) => {
      this.capturedHeaders = init?.headers as Record<RequestInput, RequestInput>;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
  }

  getClient(): HttpClient {
    return createTestHttpClient(this.baseUrl, this.interceptors);
  }

  getCapturedHeaders(): Record<RequestInput, RequestInput> {
    return { ...this.capturedHeaders };
  }

  setResponse(responseBody: any, options?: ResponseInit): void {
    global.fetch = async (url: RequestInput | URL, init?: RequestInit) => {
      Object.assign(this.capturedHeaders, init?.headers as Record<RequestInput, RequestInput> || {});
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
    };
  }

  setErrorResponse(status: number, message: RequestInput): void {
    global.fetch = async (url: RequestInput | URL, init?: RequestInit) => {
      Object.assign(this.capturedHeaders, init?.headers as Record<RequestInput, RequestInput> || {});
      return new Response(JSON.stringify({ message }), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });
    };
  }

  cleanup(): void {
    restoreFetch();
  }
}
