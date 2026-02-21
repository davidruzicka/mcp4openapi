
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryClientsStore } from './oauth-provider.js';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

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

    // Verify mcp-client-0 exists
    expect(await store.getClient('mcp-client-0')).toBeDefined();

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

  it('should skip validation for pre-registered clients (non-dynamic)', async () => {
      // Pre-registered clients might have empty redirect_uris or other special configs
      const staticClient = createClient('static-proxy');
      staticClient.redirect_uris = []; // Empty allowed for static

      await expect(store.registerClient(staticClient)).resolves.not.toThrow();
  });
});
