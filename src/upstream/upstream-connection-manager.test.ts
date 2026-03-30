/**
 * Tests for UpstreamConnectionManager
 *
 * Covers: lazy connect, concurrent dedup, closeAll, FAILED state replacement,
 * error mapping, session destruction integration, validateCredentials.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UpstreamConnectionManager } from './upstream-connection-manager.js';
import type { UpstreamMcpServerConfig } from '../types/profile.js';
import { UpstreamConnectionError, UpstreamTimeoutError, UpstreamAuthError } from './upstream-errors.js';
import { ValidationError } from '../core/errors.js';

function createMockTransport() {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    onerror: null as ((error: Error) => void) | null,
    onclose: null as (() => void) | null,
    start: vi.fn(),
  };
}

function createMockClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
  };
}

function createProvider(name = 'test-provider'): UpstreamMcpServerConfig {
  return {
    name,
    transport: { type: 'http-streamable' as const, url: 'https://upstream.example.com/mcp' },
    auth: { type: 'bearer' as const, value_from_env: 'TEST_TOKEN' },
  };
}


describe('UpstreamConnectionManager', () => {
  let manager: UpstreamConnectionManager;
  let mockClient: ReturnType<typeof createMockClient>;
  let mockTransport: ReturnType<typeof createMockTransport>;
  let clientFactory: ReturnType<typeof vi.fn>;
  let transportFactory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockTransport = createMockTransport();
    clientFactory = vi.fn().mockReturnValue(mockClient);
    transportFactory = vi.fn().mockReturnValue(mockTransport);
    manager = new UpstreamConnectionManager({ clientFactory, transportFactory });
  });

  describe('lazy initialization', () => {
    it('creates no connections at instantiation', () => {
      expect(manager.getActiveSessionCount()).toBe(0);
      expect(clientFactory).not.toHaveBeenCalled();
      expect(transportFactory).not.toHaveBeenCalled();
    });
  });

  describe('getOrConnect', () => {
    it('returns client instance on successful connect', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      const client = await manager.getOrConnect('session-1', provider, credentials);

      expect(client).toBe(mockClient);
      expect(mockClient.connect).toHaveBeenCalledWith(mockTransport);
      expect(manager.getActiveSessionCount()).toBe(1);
    });

    it('returns same client on second call (no duplicate connect)', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      const client1 = await manager.getOrConnect('session-1', provider, credentials);
      const client2 = await manager.getOrConnect('session-1', provider, credentials);

      expect(client1).toBe(client2);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent calls (same promise)', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      // Make connect slow so both calls are in-flight
      let resolveConnect!: () => void;
      mockClient.connect.mockReturnValue(
        new Promise<void>((resolve) => { resolveConnect = resolve; }),
      );

      const p1 = manager.getOrConnect('session-1', provider, credentials);
      const p2 = manager.getOrConnect('session-1', provider, credentials);

      resolveConnect();
      const [c1, c2] = await Promise.all([p1, p2]);

      expect(c1).toBe(c2);
      expect(clientFactory).toHaveBeenCalledTimes(1);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it('creates separate connections for different providers', async () => {
      const providerA = createProvider('provider-a');
      const providerB = createProvider('provider-b');
      const credentials = 'test-token';

      const mockClientA = createMockClient();
      const mockClientB = createMockClient();
      const mockTransportA = createMockTransport();
      const mockTransportB = createMockTransport();

      clientFactory.mockReturnValueOnce(mockClientA).mockReturnValueOnce(mockClientB);
      transportFactory.mockReturnValueOnce(mockTransportA).mockReturnValueOnce(mockTransportB);

      const clientA = await manager.getOrConnect('session-1', providerA, credentials);
      const clientB = await manager.getOrConnect('session-1', providerB, credentials);

      expect(clientA).toBe(mockClientA);
      expect(clientB).toBe(mockClientB);
      expect(clientFactory).toHaveBeenCalledTimes(2);
    });

    it('creates separate connections for different sessions', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      const mockClient1 = createMockClient();
      const mockClient2 = createMockClient();
      const mockTransport1 = createMockTransport();
      const mockTransport2 = createMockTransport();

      clientFactory.mockReturnValueOnce(mockClient1).mockReturnValueOnce(mockClient2);
      transportFactory.mockReturnValueOnce(mockTransport1).mockReturnValueOnce(mockTransport2);

      const c1 = await manager.getOrConnect('session-1', provider, credentials);
      const c2 = await manager.getOrConnect('session-2', provider, credentials);

      expect(c1).toBe(mockClient1);
      expect(c2).toBe(mockClient2);
      expect(manager.getActiveSessionCount()).toBe(2);
    });

    it('replaces FAILED connection with fresh one', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      await manager.getOrConnect('session-1', provider, credentials);

      // Simulate transport error setting state to FAILED
      const conn = manager.getConnection('session-1', provider.name);
      expect(conn).toBeDefined();
      conn!.state = 'FAILED';

      const freshClient = createMockClient();
      const freshTransport = createMockTransport();
      clientFactory.mockReturnValueOnce(freshClient);
      transportFactory.mockReturnValueOnce(freshTransport);

      const result = await manager.getOrConnect('session-1', provider, credentials);

      expect(result).toBe(freshClient);
      expect(freshClient.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('closeAll', () => {
    it('closes all transports for a session and removes from map', async () => {
      const providerA = createProvider('provider-a');
      const providerB = createProvider('provider-b');
      const credentials = 'test-token';

      const tA = createMockTransport();
      const tB = createMockTransport();
      transportFactory.mockReturnValueOnce(tA).mockReturnValueOnce(tB);
      clientFactory.mockReturnValueOnce(createMockClient()).mockReturnValueOnce(createMockClient());

      await manager.getOrConnect('session-1', providerA, credentials);
      await manager.getOrConnect('session-1', providerB, credentials);

      expect(manager.getActiveSessionCount()).toBe(1);

      await manager.closeAll('session-1');

      expect(tA.close).toHaveBeenCalled();
      expect(tB.close).toHaveBeenCalled();
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('is a no-op for non-existent session', async () => {
      await expect(manager.closeAll('nonexistent')).resolves.toBeUndefined();
    });

    it('allows fresh connection after closeAll', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      await manager.getOrConnect('session-1', provider, credentials);
      await manager.closeAll('session-1');

      const freshClient = createMockClient();
      const freshTransport = createMockTransport();
      clientFactory.mockReturnValueOnce(freshClient);
      transportFactory.mockReturnValueOnce(freshTransport);

      const result = await manager.getOrConnect('session-1', provider, credentials);

      expect(result).toBe(freshClient);
      expect(freshClient.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConnection', () => {
    it('returns UpstreamConnection for existing connection', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      await manager.getOrConnect('session-1', provider, credentials);

      const conn = manager.getConnection('session-1', provider.name);
      expect(conn).toBeDefined();
      expect(conn!.state).toBe('CONNECTED');
      expect(conn!.providerName).toBe('test-provider');
      expect(conn!.client).toBe(mockClient);
      expect(conn!.transport).toBe(mockTransport);
      expect(conn!.connectedAt).toBeTypeOf('number');
      expect(conn!.lastActivityAt).toBeTypeOf('number');
    });

    it('returns undefined for non-existent connection', () => {
      expect(manager.getConnection('no-session', 'no-provider')).toBeUndefined();
    });
  });

  describe('error mapping', () => {
    it('throws UpstreamConnectionError on generic connect failure', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      mockClient.connect.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(manager.getOrConnect('session-1', provider, credentials))
        .rejects.toThrow(UpstreamConnectionError);
    });

    it('throws UpstreamAuthError on 401-like connect failure', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      const authError = new Error('Unauthorized');
      (authError as Record<string, unknown>).statusCode = 401;
      mockClient.connect.mockRejectedValue(authError);

      await expect(manager.getOrConnect('session-1', provider, credentials))
        .rejects.toThrow(UpstreamAuthError);
    });

    it('throws UpstreamAuthError on 403 connect failure', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      const authError = new Error('Forbidden');
      (authError as Record<string, unknown>).statusCode = 403;
      mockClient.connect.mockRejectedValue(authError);

      await expect(manager.getOrConnect('session-1', provider, credentials))
        .rejects.toThrow(UpstreamAuthError);
    });

    it('throws UpstreamTimeoutError on timeout', async () => {
      const provider = createProvider();
      provider.timeout_ms = 5000;
      const credentials = 'test-token';

      const timeoutError = new Error('Timeout');
      timeoutError.name = 'TimeoutError';
      mockClient.connect.mockRejectedValue(timeoutError);

      await expect(manager.getOrConnect('session-1', provider, credentials))
        .rejects.toThrow(UpstreamTimeoutError);
    });

    it('clears pending connection on error', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      mockClient.connect.mockRejectedValue(new Error('fail'));

      await expect(manager.getOrConnect('session-1', provider, credentials)).rejects.toThrow();

      // After error, a new attempt should create a fresh client
      const freshClient = createMockClient();
      const freshTransport = createMockTransport();
      clientFactory.mockReturnValueOnce(freshClient);
      transportFactory.mockReturnValueOnce(freshTransport);

      const result = await manager.getOrConnect('session-1', provider, credentials);
      expect(result).toBe(freshClient);
    });
  });

  describe('transport event handlers', () => {
    it('sets state to FAILED on transport close', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      await manager.getOrConnect('session-1', provider, credentials);

      // Trigger transport onclose
      expect(mockTransport.onclose).toBeTypeOf('function');
      mockTransport.onclose!();

      const conn = manager.getConnection('session-1', provider.name);
      expect(conn!.state).toBe('FAILED');
    });

    it('sets state to FAILED on transport error', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      await manager.getOrConnect('session-1', provider, credentials);

      expect(mockTransport.onerror).toBeTypeOf('function');
      mockTransport.onerror!(new Error('transport error'));

      const conn = manager.getConnection('session-1', provider.name);
      expect(conn!.state).toBe('FAILED');
    });
  });

  describe('validateCredentials', () => {
    const SESSION_ID = 'validate-session';

    function createValidationProvider(overrides?: Partial<UpstreamMcpServerConfig>): UpstreamMcpServerConfig {
      return {
        name: 'test-provider',
        transport: { type: 'http-streamable' as const, url: 'https://upstream.example.com/mcp' },
        auth: { type: 'bearer' as const, value_from_env: 'TEST_TOKEN' },
        validation_endpoint: 'https://api.example.com/validate',
        ...overrides,
      };
    }

    let mockSsrfValidator: { validate: ReturnType<typeof vi.fn> };
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockSsrfValidator = { validate: vi.fn().mockResolvedValue(undefined) };
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('no-ops when no validation_endpoint configured', async () => {
      const providerNoEndpoint = createValidationProvider({ validation_endpoint: undefined });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, providerNoEndpoint, 'valid-token')).resolves.toBeUndefined();
      expect(mockSsrfValidator.validate).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('no-ops when token is undefined', async () => {
      const provider = createValidationProvider();
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, undefined)).resolves.toBeUndefined();
      expect(mockSsrfValidator.validate).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws ValidationError (SSRF blocked) when ssrfValidator.validate rejects', async () => {
      const provider = createValidationProvider();
      mockSsrfValidator.validate.mockRejectedValue(new ValidationError('IP address not allowed'));
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'some-token')).rejects.toThrow(ValidationError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('resolves without error when ssrfValidator passes and fetch returns 200', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'valid-token')).resolves.toBeUndefined();
    });

    it('throws UpstreamAuthError when fetch returns 401', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 401 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'bad-token')).rejects.toThrow(UpstreamAuthError);
    });

    it('throws UpstreamAuthError when fetch returns 403', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 403 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'bad-token')).rejects.toThrow(UpstreamAuthError);
    });

    it('includes provider name in UpstreamAuthError', async () => {
      const provider = createValidationProvider({ name: 'my-provider' });
      mockFetch.mockResolvedValue({ status: 401 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      const error = await mgr.validateCredentials(SESSION_ID, provider, 'bad-token').catch(e => e);
      expect(error).toBeInstanceOf(UpstreamAuthError);
      expect(error.message).toContain('my-provider');
    });

    it('throws UpstreamConnectionError when fetch rejects (network error)', async () => {
      const provider = createValidationProvider();
      mockFetch.mockRejectedValue(new Error('Network error'));
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'valid-token')).rejects.toThrow(UpstreamConnectionError);
    });

    it('throws UpstreamTimeoutError when fetch aborts (timeout)', async () => {
      const provider = createValidationProvider();
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'valid-token')).rejects.toThrow(UpstreamTimeoutError);
    });

    it('uses HEAD method by default', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await mgr.validateCredentials(SESSION_ID, provider, 'valid-token');
      expect(mockFetch).toHaveBeenCalledWith(
        provider.validation_endpoint,
        expect.objectContaining({ method: 'HEAD' }),
      );
    });

    it('uses GET method when validation_method is GET', async () => {
      const provider = createValidationProvider({ validation_method: 'GET' });
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await mgr.validateCredentials(SESSION_ID, provider, 'valid-token');
      expect(mockFetch).toHaveBeenCalledWith(
        provider.validation_endpoint,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('uses default timeout of 5000ms when validation_timeout_ms not specified', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await mgr.validateCredentials(SESSION_ID, provider, 'valid-token');
      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.signal).toBeDefined();
    });

    it('respects custom validation_timeout_ms', async () => {
      const provider = createValidationProvider({ validation_timeout_ms: 2000 });
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await mgr.validateCredentials(SESSION_ID, provider, 'valid-token');
      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.signal).toBeDefined();
    });
  });

  describe('session destruction integration', () => {
    it('closeAll called via onSessionDestroyed listener closes upstream connections', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      await manager.getOrConnect('session-1', provider, credentials);
      expect(manager.getActiveSessionCount()).toBe(1);

      // Simulate what http-transport does: call closeAll via the listener
      await manager.closeAll('session-1');
      expect(manager.getActiveSessionCount()).toBe(0);
      expect(mockTransport.close).toHaveBeenCalled();
    });

    it('reaper scenario: closing one session does not affect another', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      const t1 = createMockTransport();
      const t2 = createMockTransport();
      clientFactory.mockReturnValueOnce(createMockClient()).mockReturnValueOnce(createMockClient());
      transportFactory.mockReturnValueOnce(t1).mockReturnValueOnce(t2);

      await manager.getOrConnect('session-1', provider, credentials);
      await manager.getOrConnect('session-2', provider, credentials);

      await manager.closeAll('session-1');

      expect(t1.close).toHaveBeenCalled();
      expect(t2.close).not.toHaveBeenCalled();
      expect(manager.getActiveSessionCount()).toBe(1);
      expect(manager.getConnection('session-2', provider.name)).toBeDefined();
    });

    it('closeAll error does not propagate when caught', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      mockTransport.close.mockRejectedValue(new Error('close failed'));

      await manager.getOrConnect('session-1', provider, credentials);

      // closeAll should not throw even when transport.close rejects
      await expect(manager.closeAll('session-1')).resolves.toBeUndefined();
      expect(manager.getActiveSessionCount()).toBe(0);
    });
  });
});
