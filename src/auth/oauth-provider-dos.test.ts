
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryClientsStore } from './oauth-provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidRedirectUriError, OAuthClientStoreCapacityError } from '../core/errors.js';

describe('InMemoryClientsStore DoS Protection', () => {
  let store: InMemoryClientsStore;

  beforeEach(() => {
    store = new InMemoryClientsStore();
  });

  const createClient = (id: string, redirectUris = ['http://localhost/callback']): OAuthClientInformationFull => ({
    client_id: id,
    client_secret: 'secret',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'api'
  });

  it('should limit the number of registered clients', async () => {
    // MAX_CLIENTS is 1000
    // Register 1000 clients
    for (let i = 0; i < 1000; i++) {
      await store.registerClient(createClient(`mcp-client-${i}`));
    }

    expect(store.getClientCount()).toBe(1000);

    // Register one more
    await store.registerClient(createClient('mcp-client-overflow'));

    // Count should remain 1000
    expect(store.getClientCount()).toBe(1000);
  });

  it('should evict the oldest dynamic client when full', async () => {
    // Register 1000 clients: mcp-client-0 to mcp-client-999
    for (let i = 0; i < 1000; i++) {
      await store.registerClient(createClient(`mcp-client-${i}`));
    }

    // Register one more
    await store.registerClient(createClient('mcp-client-overflow'));

    // mcp-client-0 should be evicted (oldest dynamic)
    expect(await store.getClient('mcp-client-0')).toBeUndefined();
    // mcp-client-overflow should exist
    expect(await store.getClient('mcp-client-overflow')).toBeDefined();
    // mcp-client-1 should still exist
    expect(await store.getClient('mcp-client-1')).toBeDefined();
  });

  it('should prefer evicting dynamic clients over static ones', async () => {
    // Register a static client (simulate pre-registration)
    await store.registerClient(createClient('static-client'));

    // Register 999 dynamic clients
    for (let i = 0; i < 999; i++) {
      await store.registerClient(createClient(`mcp-client-${i}`));
    }

    expect(store.getClientCount()).toBe(1000);

    // Register one more dynamic client
    await store.registerClient(createClient('mcp-client-overflow'));

    // Static client should STILL exist
    expect(await store.getClient('static-client')).toBeDefined();

    // Oldest dynamic client (mcp-client-0) should be evicted
    expect(await store.getClient('mcp-client-0')).toBeUndefined();
  });

  it('should keep max client limit after duplicate client re-registration', async () => {
    await store.registerClient(createClient('mcp-client-0'));
    await store.registerClient(createClient('mcp-client-0'));

    for (let i = 1; i < 1000; i++) {
      await store.registerClient(createClient(`mcp-client-${i}`));
    }

    expect(store.getClientCount()).toBe(1000);

    await store.registerClient(createClient('mcp-client-overflow-1'));
    await store.registerClient(createClient('mcp-client-overflow-2'));

    expect(store.getClientCount()).toBe(1000);
  });

  it('should keep active clients and evict idle clients first', async () => {
    const configuredStore = new InMemoryClientsStore({ maxClients: 2 });
    await configuredStore.registerClient(createClient('mcp-client-active'));
    await configuredStore.registerClient(createClient('mcp-client-idle'));

    configuredStore.markSessionAttached('mcp-client-active');
    await configuredStore.registerClient(createClient('mcp-client-new'));

    expect(await configuredStore.getClient('mcp-client-active')).toBeDefined();
    expect(await configuredStore.getClient('mcp-client-idle')).toBeUndefined();
    expect(await configuredStore.getClient('mcp-client-new')).toBeDefined();
  });

  it('should reject registration when no idle candidate exists', async () => {
    const configuredStore = new InMemoryClientsStore({ maxClients: 1 });
    await configuredStore.registerClient(createClient('mcp-client-active'));
    configuredStore.markSessionAttached('mcp-client-active');

    await expect(
      configuredStore.registerClient(createClient('mcp-client-new')),
    ).rejects.toBeInstanceOf(OAuthClientStoreCapacityError);
  });

  it('should support idle grace env override', async () => {
    const envStore = new InMemoryClientsStore(
      { maxClients: 2 },
      {
        MCP4_OAUTH_CLIENT_STORE_IDLE_GRACE_MS: '999999',
      } as NodeJS.ProcessEnv,
      () => 1000,
    );
    await envStore.registerClient(createClient('mcp-client-1'));
    await envStore.registerClient(createClient('mcp-client-2'));

    await expect(
      envStore.registerClient(createClient('mcp-client-3')),
    ).rejects.toBeInstanceOf(OAuthClientStoreCapacityError);
  });

  it('should return immutable limits snapshot and apply idle grace option', () => {
    const configuredStore = new InMemoryClientsStore({
      maxClients: 3,
      maxRedirectUris: 2,
      maxRedirectUriLength: 64,
      idleGraceMs: 77,
    });

    const limits = configuredStore.getLimits();
    expect(limits).toEqual({
      maxClients: 3,
      maxRedirectUris: 2,
      maxRedirectUriLength: 64,
      idleGraceMs: 77,
    });

    limits.maxClients = 999;
    expect(configuredStore.getLimits().maxClients).toBe(3);
  });

  it('should support constructor limit overrides', async () => {
    const configuredStore = new InMemoryClientsStore({
      maxClients: 2,
      maxRedirectUris: 1,
      maxRedirectUriLength: 32,
    });

    await configuredStore.registerClient(createClient('mcp-client-1'));
    await configuredStore.registerClient(createClient('mcp-client-2'));
    await configuredStore.registerClient(createClient('mcp-client-3'));

    expect(configuredStore.getClientCount()).toBe(2);
    await expect(
      configuredStore.registerClient(
        createClient('mcp-client-too-many-uris', ['http://a', 'http://b'])
      )
    ).rejects.toThrow('Too many redirect_uris');
  });

  it('should support environment limit overrides', async () => {
    const envStore = new InMemoryClientsStore(
      {},
      {
        MCP4_OAUTH_CLIENT_STORE_MAX_CLIENTS: '2',
        MCP4_OAUTH_CLIENT_STORE_MAX_REDIRECT_URIS: '1',
        MCP4_OAUTH_CLIENT_STORE_MAX_REDIRECT_URI_LENGTH: '128',
      } as NodeJS.ProcessEnv
    );

    await envStore.registerClient(createClient('mcp-client-1'));
    await envStore.registerClient(createClient('mcp-client-2'));
    await envStore.registerClient(createClient('mcp-client-3'));

    expect(envStore.getClientCount()).toBe(2);
    await expect(
      envStore.registerClient(createClient('mcp-client-too-long', ['http://localhost/' + 'x'.repeat(256)]))
    ).rejects.toThrow('redirect_uri too long');
  });

  it('should expose metadata transitions and prevent counter underflow', async () => {
    const metadataStore = new InMemoryClientsStore({ maxClients: 10 }, {}, () => 1000);
    await metadataStore.registerClient(createClient('mcp-client-1'));

    metadataStore.markSessionAttached('mcp-client-1');
    metadataStore.markSessionDetached('mcp-client-1');
    metadataStore.markSessionDetached('mcp-client-1');
    metadataStore.markAuthStateOpened('mcp-client-1');
    metadataStore.markAuthStateClosed('mcp-client-1');
    metadataStore.markAuthStateClosed('mcp-client-1');
    metadataStore.markAuthCodeOpened('mcp-client-1');
    metadataStore.markAuthCodeClosed('mcp-client-1');
    metadataStore.markAuthCodeClosed('mcp-client-1');
    metadataStore.markClientUsed('mcp-client-1');

    const meta = metadataStore.getClientMetadataSnapshot().find((item) => item.clientId === 'mcp-client-1');
    expect(meta).toBeDefined();
    expect(meta?.activeSessionCount).toBe(0);
    expect(meta?.pendingStateCount).toBe(0);
    expect(meta?.pendingAuthCodeCount).toBe(0);
    expect(meta?.lastUsedAt).toBe(1000);
  });

  it('should ignore markClientUsed for unknown client', async () => {
    const metadataStore = new InMemoryClientsStore({ maxClients: 10 }, {}, () => 1000);
    await metadataStore.registerClient(createClient('mcp-client-1'));

    const before = metadataStore.getClientMetadataSnapshot();
    metadataStore.markClientUsed('mcp-client-missing');
    const after = metadataStore.getClientMetadataSnapshot();

    expect(after).toEqual(before);
  });

  it('should include static and pending usage in stats', async () => {
    const statsStore = new InMemoryClientsStore({ maxClients: 10 });
    await statsStore.registerClient(createClient('static-client'));
    await statsStore.registerClient(createClient('mcp-client-dynamic'));

    statsStore.markAuthStateOpened('static-client');
    statsStore.markAuthCodeOpened('mcp-client-dynamic');

    expect(statsStore.getStats()).toMatchObject({
      totalClients: 2,
      dynamicClients: 1,
      staticClients: 1,
      pendingStateClients: 1,
      pendingAuthCodeClients: 1,
    });
  });

  it('should validate redirect_uris count', async () => {
    const uris = Array(11).fill('http://localhost/callback');
    const client = createClient('mcp-client-bad-count', uris);

    await expect(store.registerClient(client)).rejects.toThrow('Too many redirect_uris');
  });

  it('should validate redirect_uris length', async () => {
    const longUri = 'http://localhost/' + 'a'.repeat(300);
    const client = createClient('mcp-client-bad-length', [longUri]);

    await expect(store.registerClient(client)).rejects.toThrow('redirect_uri too long');
  });

  it('should validate redirect_uris type', async () => {
    const client = createClient('mcp-client-bad-type', ['http://ok', 123 as any]);
    await expect(store.registerClient(client)).rejects.toThrow('redirect_uri must be a string');
  });

  it('should validate redirect_uris is array', async () => {
    const client = createClient('mcp-client-no-array');
    (client as any).redirect_uris = 'http://localhost';
    await expect(store.registerClient(client)).rejects.toThrow('redirect_uris must be an array');
  });

  it('should reject redirect validation failures with a typed InvalidRedirectUriError', async () => {
    const client = createClient('mcp-client-bad-scheme', ['http://ok', 123 as any]);
    await expect(store.registerClient(client)).rejects.toBeInstanceOf(InvalidRedirectUriError);
  });

  it('should reject dangerous and plain remote redirect schemes at registration', async () => {
    await expect(
      store.registerClient(createClient('mcp-client-js', ['javascript:alert(1)']))
    ).rejects.toThrow('redirect_uri scheme not allowed');
    await expect(
      store.registerClient(createClient('mcp-client-remote-http', ['http://remote.example.com/cb']))
    ).rejects.toThrow('redirect_uri scheme not allowed');
    await expect(
      store.registerClient(createClient('mcp-client-fragment', ['https://ok.example.com/cb#frag']))
    ).rejects.toThrow('redirect_uri scheme not allowed');
  });

  it('should accept https, loopback http, and custom scheme redirect URIs at registration', async () => {
    await store.registerClient(
      createClient('mcp-client-conformant', [
        'https://app.example.com/cb',
        'http://127.0.0.1:8080/cb',
        'http://[::1]:8080/cb',
        'cursor://anysphere.cursor-mcp/oauth/callback',
      ])
    );
    expect(await store.getClient('mcp-client-conformant')).toBeDefined();
  });

  it('should skip validation for pre-registered clients (non-dynamic)', async () => {
      // Pre-registered clients might have empty redirect_uris or other special configs
      const staticClient = createClient('static-proxy');
      staticClient.redirect_uris = []; // Empty allowed for static

      await expect(store.registerClient(staticClient)).resolves.not.toThrow();
  });
});
