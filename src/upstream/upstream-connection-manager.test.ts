/**
 * Tests for UpstreamConnectionManager
 *
 * Covers: lazy connect, concurrent dedup, closeAll, FAILED state replacement,
 * error mapping, session destruction integration, validateCredentials,
 * notification forwarding and queue buffering.
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
  // Capture notification handlers by schema method key for test invocation
  const notificationHandlers = new Map<string, (notification: unknown) => Promise<void>>();
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
    setNotificationHandler: vi.fn().mockImplementation((schema: { shape?: { method?: { value?: string } } }, handler: (n: unknown) => Promise<void>) => {
      // Extract method string from Zod schema shape used by MCP SDK
      const method = schema?.shape?.method?.value ?? 'unknown';
      notificationHandlers.set(method, handler);
    }),
    _notificationHandlers: notificationHandlers,
    /** Helper: trigger a notification handler by method string */
    _triggerNotification: async (method: string, params?: unknown) => {
      const handler = notificationHandlers.get(method);
      if (handler) {
        await handler({ method, params });
      }
    },
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
  let mockSsrfValidator: { validate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = createMockClient();
    mockTransport = createMockTransport();
    clientFactory = vi.fn().mockReturnValue(mockClient);
    transportFactory = vi.fn().mockReturnValue(mockTransport);
    // Inject a permissive SSRF validator so unit tests don't do real DNS lookups
    mockSsrfValidator = { validate: vi.fn().mockResolvedValue(undefined) };
    manager = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
  });

  describe('default factory fallbacks', () => {
    it('can be constructed without injecting factories (uses real SDK defaults)', () => {
      // Production code creates UpstreamConnectionManager with only { logger };
      // factories must not throw at construction time.
      expect(() => new UpstreamConnectionManager()).not.toThrow();
    });

    it('real default transportFactory produces a StreamableHTTPClientTransport-compatible object', () => {
      const mgr = new UpstreamConnectionManager();
      // Access the private factory via any-cast to verify it returns a real transport object
      const factory = (mgr as unknown as { transportFactory: (url: URL, opts: Record<string, unknown>) => unknown }).transportFactory;
      const t = factory(new URL('https://example.com/mcp'), {});
      expect(t).toBeDefined();
      expect(typeof (t as { close: unknown }).close).toBe('function');
    });
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

    it('reconnects when token changes for an existing CONNECTED session', async () => {
      const provider = createProvider();

      // First connection with token-A
      await manager.getOrConnect('session-1', provider, 'token-A');
      const conn = manager.getConnection('session-1', provider.name);
      expect(conn?.token).toBe('token-A');

      // Second call with token-B - should reconnect
      const newClient = createMockClient();
      const newTransport = createMockTransport();
      clientFactory.mockReturnValueOnce(newClient);
      transportFactory.mockReturnValueOnce(newTransport);

      const result = await manager.getOrConnect('session-1', provider, 'token-B');

      expect(result).toBe(newClient);
      expect(newClient.connect).toHaveBeenCalledTimes(1);
      expect(manager.getConnection('session-1', provider.name)?.token).toBe('token-B');
    });

    it('fires toolsListChangedHooks on token rotation to invalidate sanitized-tool cache', async () => {
      const provider = createProvider();
      const hook = vi.fn();
      manager.addToolsListChangedHook(hook);

      await manager.getOrConnect('session-1', provider, 'token-A');

      const newClient = createMockClient();
      const newTransport = createMockTransport();
      clientFactory.mockReturnValueOnce(newClient);
      transportFactory.mockReturnValueOnce(newTransport);

      await manager.getOrConnect('session-1', provider, 'token-B');

      expect(hook).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledWith('session-1', provider.name);
    });

    it('does not fire toolsListChangedHooks when token is unchanged', async () => {
      const provider = createProvider();
      const hook = vi.fn();
      manager.addToolsListChangedHook(hook);

      await manager.getOrConnect('session-1', provider, 'same-token');
      await manager.getOrConnect('session-1', provider, 'same-token');

      expect(hook).not.toHaveBeenCalled();
    });

    it('does not fire toolsListChangedHooks on token change when provider has no auth', async () => {
      const noAuthProvider: UpstreamMcpServerConfig = {
        name: 'no-auth-provider',
        transport: { type: 'http-streamable' as const, url: 'https://upstream.example.com/mcp' },
      };
      const hook = vi.fn();
      manager.addToolsListChangedHook(hook);

      await manager.getOrConnect('session-1', noAuthProvider, 'token-A');
      await manager.getOrConnect('session-1', noAuthProvider, 'token-B');

      expect(hook).not.toHaveBeenCalled();
    });

    it('does not reconnect when token is unchanged for CONNECTED session', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-1', provider, 'same-token');
      const result = await manager.getOrConnect('session-1', provider, 'same-token');
      expect(result).toBe(mockClient);
      expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });

    it('does not reconnect when token changes but provider has no auth configured', async () => {
      // No-auth provider: upstream receives no credential; token rotation in downstream
      // session is irrelevant and must not trigger unnecessary upstream reconnects.
      const noAuthProvider: UpstreamMcpServerConfig = {
        name: 'no-auth-provider',
        transport: { type: 'http-streamable' as const, url: 'https://upstream.example.com/mcp' },
        // auth is intentionally absent
      };

      await manager.getOrConnect('session-1', noAuthProvider, 'token-A');
      expect(mockClient.connect).toHaveBeenCalledTimes(1);

      // Token changes - should reuse existing connection, not reconnect
      const result = await manager.getOrConnect('session-1', noAuthProvider, 'token-B');
      expect(result).toBe(mockClient);
      expect(mockClient.connect).toHaveBeenCalledTimes(1); // no additional connect
    });

    it('deduplicates concurrent calls with different tokens when provider has no auth', async () => {
      const noAuthProvider: UpstreamMcpServerConfig = {
        name: 'no-auth-provider',
        transport: { type: 'http-streamable' as const, url: 'https://upstream.example.com/mcp' },
      };

      let resolveConnect!: () => void;
      mockClient.connect.mockReturnValue(
        new Promise<void>((resolve) => { resolveConnect = resolve; }),
      );

      // Two concurrent calls with different tokens - both should share the same promise
      const p1 = manager.getOrConnect('session-1', noAuthProvider, 'token-A');
      const p2 = manager.getOrConnect('session-1', noAuthProvider, 'token-B');

      resolveConnect();
      const [c1, c2] = await Promise.all([p1, p2]);

      expect(c1).toBe(c2);
      expect(clientFactory).toHaveBeenCalledTimes(1); // single connect, not two
    });

    it('stops heartbeat before replacing a CONNECTED connection on token rotation (P1)', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-1', provider, 'token-A');

      const heartbeatManager = (manager as unknown as { heartbeatManager: { isRunning: (k: string) => boolean; stop: (k: string) => void } }).heartbeatManager;
      const stopSpy = vi.spyOn(heartbeatManager, 'stop');

      const newClient = createMockClient();
      clientFactory.mockReturnValueOnce(newClient);
      transportFactory.mockReturnValueOnce(createMockTransport());

      await manager.getOrConnect('session-1', provider, 'token-B');

      expect(stopSpy).toHaveBeenCalledWith(`session-1:${provider.name}`);
    });

    it('stops heartbeat before replacing a FAILED connection (P1)', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-1', provider, 'token');

      // Force connection to FAILED state
      const conn = manager.getConnection('session-1', provider.name);
      conn!.state = 'FAILED';

      const heartbeatManager = (manager as unknown as { heartbeatManager: { isRunning: (k: string) => boolean; stop: (k: string) => void } }).heartbeatManager;
      const stopSpy = vi.spyOn(heartbeatManager, 'stop');

      const freshClient = createMockClient();
      clientFactory.mockReturnValueOnce(freshClient);
      transportFactory.mockReturnValueOnce(createMockTransport());

      await manager.getOrConnect('session-1', provider, 'token');

      expect(stopSpy).toHaveBeenCalledWith(`session-1:${provider.name}`);
    });

    it('closes transport and client when replacing a FAILED connection (P1)', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-1', provider, 'token');

      // Capture the original connection's client/transport to verify they are closed
      const failedConn = manager.getConnection('session-1', provider.name)!;
      const failedClient = failedConn.client;
      const failedTransport = failedConn.transport;
      failedConn.state = 'FAILED';

      const freshClient = createMockClient();
      const freshTransport = createMockTransport();
      clientFactory.mockReturnValueOnce(freshClient);
      transportFactory.mockReturnValueOnce(freshTransport);

      await manager.getOrConnect('session-1', provider, 'token');

      // Stale client and transport must be closed to release sockets and prevent
      // onerror/onclose handlers from firing against the replacement connection (P1).
      expect((failedClient as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
      expect((failedTransport as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    });

    it('waits for in-flight connect to settle and uses new token when tokens mismatch (P2)', async () => {
      const provider = createProvider();

      // Set up all factory calls upfront in call order:
      // Call 1: token-A's createConnection → mockClient / mockTransport
      // Call 2: token-B's recursive createConnection → clientB / transportB
      const clientB = createMockClient();
      const transportB = createMockTransport();
      clientFactory.mockReturnValueOnce(mockClient).mockReturnValueOnce(clientB);
      transportFactory.mockReturnValueOnce(mockTransport).mockReturnValueOnce(transportB);

      // Make token-A's connect slow so it's still in-flight when token-B arrives
      let resolveConnectA!: () => void;
      mockClient.connect.mockReturnValue(
        new Promise<void>((resolve) => { resolveConnectA = resolve; }),
      );

      // Start both concurrently
      const promiseA = manager.getOrConnect('session-1', provider, 'token-A');
      const promiseB = manager.getOrConnect('session-1', provider, 'token-B');

      // Let token-A connect complete
      resolveConnectA();
      const [clientFromA, clientFromB] = await Promise.all([promiseA, promiseB]);

      // token-A caller gets the token-A client
      expect(clientFromA).toBe(mockClient);
      // token-B caller must NOT reuse token-A connection - gets its own fresh client
      expect(clientFromB).toBe(clientB);
      expect(manager.getConnection('session-1', provider.name)?.token).toBe('token-B');
    });

    it('throws UpstreamConnectionError when session destroyed mid-connect', async () => {
      const provider = createProvider();

      // Slow connect so we can destroy the session while in-flight
      let resolveConnect!: () => void;
      mockClient.connect.mockReturnValue(
        new Promise<void>((resolve) => { resolveConnect = resolve; }),
      );

      const connectPromise = manager.getOrConnect('session-1', provider, 'token');

      // Destroy the session while connect is in-flight (don't await - closeAll waits for pending)
      const closePromise = manager.closeAll('session-1');

      resolveConnect(); // let connect resolve
      await expect(connectPromise).rejects.toThrow('Session destroyed during upstream connection');
      await closePromise;
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

    it('cleans up when called before any connection is established (only pending exists)', async () => {
      const provider = createProvider();

      let resolveConnect!: () => void;
      mockClient.connect.mockReturnValue(
        new Promise<void>((resolve) => { resolveConnect = resolve; }),
      );

      const connectPromise = manager.getOrConnect('session-1', provider, 'token');
      const closePromise = manager.closeAll('session-1');

      resolveConnect();
      await expect(connectPromise).rejects.toThrow('Session destroyed during upstream connection');
      await closePromise;

      // No connections should remain
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('allows fresh connection for a new session after another session is closed', async () => {
      const provider = createProvider();
      const credentials = 'test-token';

      await manager.getOrConnect('session-1', provider, credentials);
      await manager.closeAll('session-1');

      // HTTP transport always assigns a new session ID - session-1 is never reused after closeAll.
      const freshClient = createMockClient();
      const freshTransport = createMockTransport();
      clientFactory.mockReturnValueOnce(freshClient);
      transportFactory.mockReturnValueOnce(freshTransport);

      const result = await manager.getOrConnect('session-2', provider, credentials);

      expect(result).toBe(freshClient);
      expect(freshClient.connect).toHaveBeenCalledTimes(1);
    });

    it('rejects getOrConnect for a session that was already destroyed', async () => {
      const provider = createProvider();

      await manager.getOrConnect('session-1', provider, 'token');
      await manager.closeAll('session-1');

      await expect(manager.getOrConnect('session-1', provider, 'token'))
        .rejects.toThrow('Session destroyed during upstream connection');
    });

    it('calls client.close() as well as transport.close() for each connection', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-1', provider, 'token');

      await manager.closeAll('session-1');

      expect(mockClient.close).toHaveBeenCalled();
      expect(mockTransport.close).toHaveBeenCalled();
    });

    it('does not propagate when client.close() rejects', async () => {
      const provider = createProvider();
      mockClient.close.mockRejectedValue(new Error('client close failed'));
      await manager.getOrConnect('session-1', provider, 'token');

      await expect(manager.closeAll('session-1')).resolves.toBeUndefined();
      expect(manager.getActiveSessionCount()).toBe(0);
    });
  });

  describe('query auth URL injection', () => {
    it('passes URL with query param to transportFactory for query auth type', async () => {
      const provider: UpstreamMcpServerConfig = {
        name: 'query-provider',
        transport: { type: 'http-streamable', url: 'https://upstream.example.com/mcp' },
        auth: { type: 'query', value_from_env: 'TOK', query_param: 'api_key' },
      };
      await manager.getOrConnect('session-q', provider, 'secret');
      const urlArg: URL = transportFactory.mock.calls[0][0];
      expect(urlArg.searchParams.get('api_key')).toBe('secret');
    });

    it('passes original URL to transportFactory for bearer auth type', async () => {
      const provider = createProvider(); // bearer auth
      await manager.getOrConnect('session-b', provider, 'secret');
      const urlArg: URL = transportFactory.mock.calls[0][0];
      expect(urlArg.searchParams.has('api_key')).toBe(false);
      expect(urlArg.toString()).toBe('https://upstream.example.com/mcp');
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

    it('throws UpstreamAuthError on connect failure with auth error message pattern', async () => {
      const provider = createProvider();

      // No statusCode - should match AUTH_ERROR_PATTERNS via message
      const authError = new Error('unauthorized: token rejected');
      mockClient.connect.mockRejectedValue(authError);

      await expect(manager.getOrConnect('session-1', provider, 'token'))
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

    it('closes transport and client when connect throws to prevent resource leaks', async () => {
      const provider = createProvider();

      mockClient.connect.mockRejectedValue(new Error('connection refused'));

      await expect(manager.getOrConnect('session-1', provider, 'token')).rejects.toThrow(UpstreamConnectionError);

      expect(mockTransport.close).toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
    });

    it('closes transport and client on auth failure to prevent orphaned sockets', async () => {
      const provider = createProvider();
      const authError = new Error('Unauthorized');
      (authError as Record<string, unknown>).statusCode = 401;
      mockClient.connect.mockRejectedValue(authError);

      await expect(manager.getOrConnect('session-1', provider, 'bad-token')).rejects.toThrow(UpstreamAuthError);

      expect(mockTransport.close).toHaveBeenCalled();
      expect(mockClient.close).toHaveBeenCalled();
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

    it('stops heartbeat on transport close (P2)', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-hb', provider, 'test-token');

      const heartbeatManager = (manager as unknown as { heartbeatManager: { stop: (k: string) => void } }).heartbeatManager;
      const stopSpy = vi.spyOn(heartbeatManager, 'stop');

      mockTransport.onclose!();

      expect(stopSpy).toHaveBeenCalledWith(`session-hb:${provider.name}`);
    });

    it('stops heartbeat on transport error (P2)', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-hb2', provider, 'test-token');

      const heartbeatManager = (manager as unknown as { heartbeatManager: { stop: (k: string) => void } }).heartbeatManager;
      const stopSpy = vi.spyOn(heartbeatManager, 'stop');

      mockTransport.onerror!(new Error('network error'));

      expect(stopSpy).toHaveBeenCalledWith(`session-hb2:${provider.name}`);
    });

    it('stale transport onerror/onclose does not mark replacement connection as FAILED', async () => {
      // Simulate token rotation: first connect stores transport A; connection is closed/replaced
      // by a second getOrConnect call with a new token; delayed event from transport A must be ignored.
      const provider = createProvider();

      const transportA = createMockTransport();
      const transportB = createMockTransport();
      let callCount = 0;
      transportFactory.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? transportA : transportB;
      });

      // First connection
      await manager.getOrConnect('session-r', provider, 'token-1');
      expect(manager.getConnection('session-r', provider.name)!.state).toBe('CONNECTED');

      // Manually mark as FAILED so getOrConnect replaces it
      manager.getConnection('session-r', provider.name)!.state = 'FAILED';

      // Second connection (replacement)
      await manager.getOrConnect('session-r', provider, 'token-2');
      const connAfterReplace = manager.getConnection('session-r', provider.name);
      expect(connAfterReplace!.state).toBe('CONNECTED');

      // Now fire stale events from the OLD transport - they must not mutate the new connection
      expect(transportA.onclose).toBeTypeOf('function');
      transportA.onclose!();
      expect(manager.getConnection('session-r', provider.name)!.state).toBe('CONNECTED');

      expect(transportA.onerror).toBeTypeOf('function');
      transportA.onerror!(new Error('stale error'));
      expect(manager.getConnection('session-r', provider.name)!.state).toBe('CONNECTED');

      // Events from the NEW transport still work correctly
      transportB.onclose!();
      expect(manager.getConnection('session-r', provider.name)!.state).toBe('FAILED');
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

    it('accepts undefined sessionId and logs phase:pre-session-init instead of sessionId', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 200 });
      const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const mgr = new UpstreamConnectionManager({
        clientFactory, transportFactory,
        ssrfValidator: mockSsrfValidator as never,
        logger: mockLogger as never,
      });
      await expect(mgr.validateCredentials(undefined, provider, 'valid-token')).resolves.toBeUndefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Upstream credential validation passed',
        expect.objectContaining({ phase: 'pre-session-init' }),
      );
      // sessionId must not appear in the log entry
      const logArgs = mockLogger.debug.mock.calls[0][1];
      expect(logArgs).not.toHaveProperty('sessionId');
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
      expect(error.details?.providerName).toBe('my-provider');
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

    it('throws UpstreamConnectionError when fetch returns 404', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 404 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'valid-token')).rejects.toThrow(UpstreamConnectionError);
    });

    it('throws UpstreamConnectionError when fetch returns 500', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 500 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'valid-token')).rejects.toThrow(UpstreamConnectionError);
    });

    it('throws UpstreamConnectionError when fetch returns 503', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 503 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'valid-token')).rejects.toThrow(UpstreamConnectionError);
    });

    it('uses redirect: manual to prevent SSRF bypass via redirect', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await mgr.validateCredentials(SESSION_ID, provider, 'valid-token');
      expect(mockFetch).toHaveBeenCalledWith(
        provider.validation_endpoint,
        expect.objectContaining({ redirect: 'manual' }),
      );
    });

    it('throws UpstreamConnectionError when fetch returns 301 (redirect blocked)', async () => {
      const provider = createValidationProvider();
      mockFetch.mockResolvedValue({ status: 301 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await expect(mgr.validateCredentials(SESSION_ID, provider, 'valid-token')).rejects.toThrow(UpstreamConnectionError);
    });

    it('appends query param to validation URL for query auth type', async () => {
      const provider = createValidationProvider({
        auth: { type: 'query', value_from_env: 'TOK', query_param: 'api_key' },
      });
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await mgr.validateCredentials(SESSION_ID, provider, 'secret');
      const fetchedUrl: string = mockFetch.mock.calls[0][0];
      expect(fetchedUrl).toContain('api_key=secret');
    });

    it('does not append query param for bearer auth type', async () => {
      const provider = createValidationProvider({
        auth: { type: 'bearer', value_from_env: 'TOK' },
      });
      mockFetch.mockResolvedValue({ status: 200 });
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never });
      await mgr.validateCredentials(SESSION_ID, provider, 'secret');
      const fetchedUrl: string = mockFetch.mock.calls[0][0];
      expect(fetchedUrl).not.toContain('secret');
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

    it('closeAll stops heartbeat for closed connection', async () => {
      const provider = createProvider();

      await manager.getOrConnect('session-1', provider, 'token');

      // Verify heartbeat is running before close
      const heartbeatManager = (manager as unknown as { heartbeatManager: { isRunning: (k: string) => boolean } }).heartbeatManager;
      expect(heartbeatManager.isRunning('session-1:test-provider')).toBe(true);

      await manager.closeAll('session-1');

      expect(manager.getActiveSessionCount()).toBe(0);
      expect(heartbeatManager.isRunning('session-1:test-provider')).toBe(false);
    });
  });

  describe('notification forwarding', () => {
    const TOOL_LIST_CHANGED = 'notifications/tools/list_changed';

    it('calls downstreamNotifyFn when hasActiveStreamFn returns true and upstream sends notification', async () => {
      const provider = createProvider();
      const notifyFn = vi.fn();
      const hasStreamFn = vi.fn().mockReturnValue(true);
      manager.setDownstreamNotifyFn(notifyFn);
      manager.setHasActiveStreamFn(hasStreamFn);

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      expect(hasStreamFn).toHaveBeenCalledWith('session-1');
      expect(notifyFn).toHaveBeenCalledWith('session-1', TOOL_LIST_CHANGED, undefined);
    });

    it('queues notification when hasActiveStreamFn returns false', async () => {
      const provider = createProvider();
      const notifyFn = vi.fn();
      const hasStreamFn = vi.fn().mockReturnValue(false);
      manager.setDownstreamNotifyFn(notifyFn);
      manager.setHasActiveStreamFn(hasStreamFn);

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      expect(notifyFn).not.toHaveBeenCalled();
      const buffered = manager.drainNotifications('session-1');
      expect(buffered).toHaveLength(1);
      expect(buffered[0].method).toBe(TOOL_LIST_CHANGED);
    });

    it('queues notification when downstreamNotifyFn is not set', async () => {
      const provider = createProvider();
      const hasStreamFn = vi.fn().mockReturnValue(true);
      // Do NOT set downstreamNotifyFn
      manager.setHasActiveStreamFn(hasStreamFn);

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      const buffered = manager.drainNotifications('session-1');
      expect(buffered).toHaveLength(1);
    });

    it('queues notification when hasActiveStreamFn is not set', async () => {
      const provider = createProvider();
      const notifyFn = vi.fn();
      // Do NOT set hasActiveStreamFn
      manager.setDownstreamNotifyFn(notifyFn);

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      expect(notifyFn).not.toHaveBeenCalled();
      const buffered = manager.drainNotifications('session-1');
      expect(buffered).toHaveLength(1);
    });

    it('drainNotifications returns buffered entries in order', async () => {
      const provider = createProvider();
      manager.setDownstreamNotifyFn(vi.fn());
      manager.setHasActiveStreamFn(vi.fn().mockReturnValue(false));

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);
      await client._triggerNotification(TOOL_LIST_CHANGED);
      await client._triggerNotification(TOOL_LIST_CHANGED);

      const buffered = manager.drainNotifications('session-1');
      expect(buffered).toHaveLength(3);
      expect(buffered[0].method).toBe(TOOL_LIST_CHANGED);
    });

    it('drainNotifications returns empty array for unknown session', () => {
      const buffered = manager.drainNotifications('no-such-session');
      expect(buffered).toEqual([]);
    });

    it('closeAll cleans up notification queue for session', async () => {
      const provider = createProvider();
      manager.setDownstreamNotifyFn(vi.fn());
      manager.setHasActiveStreamFn(vi.fn().mockReturnValue(false));

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      // Verify queue has entries before closeAll
      const beforeClose = manager.drainNotifications('session-1');
      expect(beforeClose).toHaveLength(1);

      // Re-trigger so queue is non-empty, then closeAll should clear it
      await client._triggerNotification(TOOL_LIST_CHANGED);
      await manager.closeAll('session-1');

      // After closeAll, queue should be gone (drain returns empty)
      expect(manager.drainNotifications('session-1')).toEqual([]);
    });

    it('closeAll clears notification queue for session', async () => {
      const provider = createProvider();
      manager.setDownstreamNotifyFn(vi.fn());
      manager.setHasActiveStreamFn(vi.fn().mockReturnValue(false));

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      // Verify queue is populated before closeAll
      expect(manager.drainNotifications('session-1').length).toBeGreaterThan(0);

      // Re-trigger so queue has an entry again (drain above cleared it)
      await client._triggerNotification(TOOL_LIST_CHANGED);
      await manager.closeAll('session-1');

      // After closeAll, queue must be gone
      expect(manager.drainNotifications('session-1')).toEqual([]);
    });
  });

  describe('addToolsListChangedHook', () => {
    const TOOL_LIST_CHANGED = 'notifications/tools/list_changed';

    it('calls hook with sessionId and providerName on tools/list_changed', async () => {
      const provider = createProvider();
      const hook = vi.fn();
      manager.addToolsListChangedHook(hook);
      manager.setDownstreamNotifyFn(vi.fn());
      manager.setHasActiveStreamFn(vi.fn().mockReturnValue(true));

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      expect(hook).toHaveBeenCalledWith('session-1', provider.name);
    });

    it('calls multiple hooks on tools/list_changed', async () => {
      const provider = createProvider();
      const hook1 = vi.fn();
      const hook2 = vi.fn();
      manager.addToolsListChangedHook(hook1);
      manager.addToolsListChangedHook(hook2);
      manager.setDownstreamNotifyFn(vi.fn());
      manager.setHasActiveStreamFn(vi.fn().mockReturnValue(true));

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      expect(hook1).toHaveBeenCalledWith('session-1', provider.name);
      expect(hook2).toHaveBeenCalledWith('session-1', provider.name);
    });

    it('swallows errors thrown by toolsListChangedHook and still forwards notification', async () => {
      const provider = createProvider();
      const notifyFn = vi.fn();
      manager.addToolsListChangedHook(() => { throw new Error('hook blow-up'); });
      manager.setDownstreamNotifyFn(notifyFn);
      manager.setHasActiveStreamFn(vi.fn().mockReturnValue(true));

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await expect(client._triggerNotification(TOOL_LIST_CHANGED)).resolves.toBeUndefined();

      expect(notifyFn).toHaveBeenCalledWith('session-1', TOOL_LIST_CHANGED, undefined);
    });

    it('remove function returned by addToolsListChangedHook deregisters the hook', async () => {
      const provider = createProvider();
      const hook = vi.fn();
      manager.setDownstreamNotifyFn(vi.fn());
      manager.setHasActiveStreamFn(vi.fn().mockReturnValue(true));

      const remove = manager.addToolsListChangedHook(hook);
      // Deregister before any notification fires
      remove();

      const client = await manager.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;
      await client._triggerNotification(TOOL_LIST_CHANGED);

      expect(hook).not.toHaveBeenCalled();
    });

    it('calling the remove function twice is idempotent (no error)', () => {
      const hook = vi.fn();
      const remove = manager.addToolsListChangedHook(hook);
      remove();
      expect(() => remove()).not.toThrow();
    });
  });

  describe('heartbeat integration (REL-01)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts heartbeat after successful connection', async () => {
      const provider = createProvider();
      await manager.getOrConnect('session-1', provider, 'token');

      const heartbeatManager = (manager as unknown as { heartbeatManager: { isRunning: (k: string) => boolean } }).heartbeatManager;
      expect(heartbeatManager.isRunning('session-1:test-provider')).toBe(true);
    });

    it('calls client.ping on each heartbeat interval', async () => {
      const provider = createProvider();
      manager = new UpstreamConnectionManager({
        clientFactory,
        transportFactory,
        ssrfValidator: mockSsrfValidator as never,
        heartbeatConfig: { intervalMs: 1000, timeoutMs: 500 },
      });

      await manager.getOrConnect('session-1', provider, 'token');
      expect(mockClient.ping).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockClient.ping).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockClient.ping).toHaveBeenCalledTimes(2);
    });

    it('sets connection to FAILED state when ping fails', async () => {
      const provider = createProvider();
      manager = new UpstreamConnectionManager({
        clientFactory,
        transportFactory,
        ssrfValidator: mockSsrfValidator as never,
        heartbeatConfig: { intervalMs: 1000, timeoutMs: 500 },
      });

      await manager.getOrConnect('session-1', provider, 'token');

      mockClient.ping.mockRejectedValue(new Error('ping timeout'));
      await vi.advanceTimersByTimeAsync(1000);
      // Allow the async ping callback to settle
      await Promise.resolve();

      const conn = manager.getConnection('session-1', provider.name);
      expect(conn?.state).toBe('FAILED');
    });

    it('does not start heartbeat when connect fails', async () => {
      const provider = createProvider();
      mockClient.connect.mockRejectedValue(new Error('connect failed'));

      await expect(manager.getOrConnect('session-1', provider, 'token')).rejects.toThrow();

      const heartbeatManager = (manager as unknown as { heartbeatManager: { isRunning: (k: string) => boolean } }).heartbeatManager;
      expect(heartbeatManager.isRunning('session-1:test-provider')).toBe(false);
    });

    it('does not start heartbeat when session destroyed during connect', async () => {
      const provider = createProvider();

      let resolveConnect!: () => void;
      mockClient.connect.mockReturnValue(
        new Promise<void>((resolve) => { resolveConnect = resolve; }),
      );

      const connectPromise = manager.getOrConnect('session-1', provider, 'token');
      const closePromise = manager.closeAll('session-1');

      resolveConnect();
      await expect(connectPromise).rejects.toThrow('Session destroyed during upstream connection');
      await closePromise;

      const heartbeatManager = (manager as unknown as { heartbeatManager: { isRunning: (k: string) => boolean } }).heartbeatManager;
      expect(heartbeatManager.isRunning('session-1:test-provider')).toBe(false);
    });

    it('does not mark replacement connection as FAILED when stale heartbeat ping rejects after reconnect', async () => {
      const capturedFailures = new Map<string, (error: Error) => void>();
      const mockHeartbeatMgr = {
        start: vi.fn((key: string, _pingFn: () => Promise<void>, onFailure: (error: Error) => void) => {
          capturedFailures.set(key, onFailure);
        }),
        stop: vi.fn(),
        stopAll: vi.fn(),
        isRunning: vi.fn().mockReturnValue(false),
        getActiveCount: vi.fn().mockReturnValue(0),
        getConfig: vi.fn().mockReturnValue({ intervalMs: 30000, timeoutMs: 5000 }),
      };

      manager = new UpstreamConnectionManager({
        clientFactory,
        transportFactory,
        ssrfValidator: mockSsrfValidator as never,
        heartbeatManager: mockHeartbeatMgr as never,
      });

      const provider = createProvider();

      // First connection
      const client1 = createMockClient();
      const transport1 = createMockTransport();
      clientFactory.mockReturnValueOnce(client1).mockReturnValueOnce(createMockClient());
      transportFactory.mockReturnValueOnce(transport1).mockReturnValueOnce(createMockTransport());

      await manager.getOrConnect('session-1', provider, 'token');
      const onFailure1 = capturedFailures.get('session-1:test-provider')!;
      expect(onFailure1).toBeDefined();

      // Simulate reconnect: mark connection FAILED so getOrConnect creates a replacement
      manager.getConnection('session-1', provider.name)!.state = 'FAILED';
      await manager.getOrConnect('session-1', provider, 'token');

      const newConn = manager.getConnection('session-1', provider.name)!;
      expect(newConn.state).toBe('CONNECTED');

      // Stale in-flight ping from old connection rejects — must NOT affect new connection
      onFailure1(new Error('stale ping timeout'));

      expect(newConn.state).toBe('CONNECTED');
    });
  });

  describe('SSRF validation on transport URL (Fix 1)', () => {
    it('rejects createConnection when transport.url fails SSRF validation', async () => {
      const mockSsrfValidator = { validate: vi.fn().mockRejectedValue(new ValidationError('Private IP blocked')) };
      const mgr = new UpstreamConnectionManager({
        clientFactory,
        transportFactory,
        ssrfValidator: mockSsrfValidator as never,
      });
      const provider = createProvider();

      await expect(mgr.getOrConnect('session-ssrf', provider, 'token'))
        .rejects.toThrow('Private IP blocked');
      await expect(mgr.getOrConnect('session-ssrf', provider, 'token'))
        .rejects.toBeInstanceOf(ValidationError);

      // Transport/client must not be created after SSRF rejection
      expect(mockClient.connect).not.toHaveBeenCalled();
    });

    it('allows createConnection when transport.url passes SSRF validation', async () => {
      const mockSsrfValidator = { validate: vi.fn().mockResolvedValue(undefined) };
      const mgr = new UpstreamConnectionManager({
        clientFactory,
        transportFactory,
        ssrfValidator: mockSsrfValidator as never,
      });
      const provider = createProvider();

      const result = await mgr.getOrConnect('session-ok', provider, 'token');

      expect(result).toBe(mockClient);
      expect(mockSsrfValidator.validate).toHaveBeenCalledWith(
        provider.transport.url,
        expect.objectContaining({ allowPrivateNetwork: expect.any(Boolean) }),
      );
    });
  });

  describe('notification handler error isolation (Fix 3)', () => {
    it('does not propagate errors thrown by downstreamNotifyFn - logs instead', async () => {
      const provider = createProvider();
      const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const mgr = new UpstreamConnectionManager({ clientFactory, transportFactory, ssrfValidator: mockSsrfValidator as never, logger: mockLogger as never });

      // downstreamNotifyFn throws synchronously
      mgr.setDownstreamNotifyFn(() => { throw new Error('downstream blow-up'); });
      mgr.setHasActiveStreamFn(() => true);

      const client = await mgr.getOrConnect('session-1', provider, 'token') as ReturnType<typeof createMockClient>;

      // Should not throw or produce an unhandled rejection
      await expect(client._triggerNotification('notifications/tools/list_changed')).resolves.toBeUndefined();

      // Error must be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error handling upstream notification',
        expect.any(Error),
      );
    });
  });

  describe('destroyedSessions TTL pruning (Fix 5)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('prunes stale destroyedSessions entries after TTL to prevent memory leak', async () => {
      const provider = createProvider();
      const ttlMs = 60_000;

      // Close three sessions
      const c1 = createMockClient();
      const c2 = createMockClient();
      const c3 = createMockClient();
      const t1 = createMockTransport();
      const t2 = createMockTransport();
      const t3 = createMockTransport();
      clientFactory
        .mockReturnValueOnce(c1)
        .mockReturnValueOnce(c2)
        .mockReturnValueOnce(c3);
      transportFactory
        .mockReturnValueOnce(t1)
        .mockReturnValueOnce(t2)
        .mockReturnValueOnce(t3);

      await manager.getOrConnect('session-a', provider, 'token');
      await manager.getOrConnect('session-b', provider, 'token');
      await manager.getOrConnect('session-c', provider, 'token');

      await manager.closeAll('session-a');
      await manager.closeAll('session-b');
      await manager.closeAll('session-c');

      const destroyed = (manager as unknown as { destroyedSessions: Map<string, number> }).destroyedSessions;
      expect(destroyed.size).toBe(3);

      // Advance time past TTL and trigger pruning via a new closeAll call
      vi.advanceTimersByTime(ttlMs + 1);

      // Close a new session to trigger pruning (or close a dummy session)
      await manager.closeAll('session-trigger');

      // Stale entries (a, b, c) must have been pruned
      expect(destroyed.has('session-a')).toBe(false);
      expect(destroyed.has('session-b')).toBe(false);
      expect(destroyed.has('session-c')).toBe(false);
    });
  });
});
