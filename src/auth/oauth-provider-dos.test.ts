import { describe, it, expect } from 'vitest';
import { InMemoryClientsStore } from './oauth-provider.js';
import { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

describe('InMemoryClientsStore DoS Protection', () => {
  it('should limit the number of clients to 1000', async () => {
    const store = new InMemoryClientsStore();
    const limit = 1100; // Try to add more than 1000

    // Add clients with dynamic prefix
    for (let i = 0; i < limit; i++) {
      const client: OAuthClientInformationFull = {
        client_id: `mcp-client-${i}`,
        client_secret: 'secret',
        redirect_uris: ['http://localhost'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'api',
      };
      await store.registerClient(client);
    }

    // Check size. MAX_CLIENTS is 1000.
    expect((store as any).clients.size).toBe(1000);

    // Verify eviction: The first added (mcp-client-0) should be gone (FIFO/Dynamic eviction)
    // Eviction logic prioritizes dynamic clients found in iteration order.
    // Since iteration order is insertion order, mcp-client-0 is found first.
    const firstClient = await store.getClient('mcp-client-0');
    expect(firstClient).toBeUndefined();

    // The last added client should exist
    const lastClient = await store.getClient(`mcp-client-${limit - 1}`);
    expect(lastClient).toBeDefined();
  });

  it('should prioritize evicting dynamic clients over static ones', async () => {
    const store = new InMemoryClientsStore();

    // Add a static client (simulate config-based client)
    const staticClient: OAuthClientInformationFull = {
        client_id: 'static-client',
        client_secret: 'secret',
        redirect_uris: ['http://localhost'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'api',
    };
    await store.registerClient(staticClient);

    // Add 1100 dynamic clients.
    // First 999 fill the store (1 static + 999 dynamic = 1000).
    // Next ones trigger eviction.
    for (let i = 0; i < 1100; i++) {
       const client: OAuthClientInformationFull = {
        client_id: `mcp-client-${i}`,
        client_secret: 'secret',
        redirect_uris: ['http://localhost'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'api',
      };
      await store.registerClient(client);
    }

    // Size should be 1000
    expect((store as any).clients.size).toBe(1000);

    // Static client should STILL be there (eviction should pick dynamic client)
    const retrievedStatic = await store.getClient('static-client');
    expect(retrievedStatic).toBeDefined();

    // Check if early dynamic clients were evicted.
    const evictedDynamic = await store.getClient('mcp-client-0');
    expect(evictedDynamic).toBeUndefined();

    const lastDynamic = await store.getClient('mcp-client-1099');
    expect(lastDynamic).toBeDefined();
  });

  it('should fall back to FIFO eviction when no dynamic clients exist', async () => {
    const store = new InMemoryClientsStore();
    const limit = 1000;

    // Fill the store with ONLY static clients
    for (let i = 0; i < limit; i++) {
      const client: OAuthClientInformationFull = {
        client_id: `static-client-${i}`,
        client_secret: 'secret',
        redirect_uris: ['http://localhost'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'api',
      };
      await store.registerClient(client);
    }

    // Size should be 1000
    expect((store as any).clients.size).toBe(1000);

    // Add one more static client to trigger eviction
    const newClient: OAuthClientInformationFull = {
      client_id: `static-client-${limit}`,
      client_secret: 'secret',
      redirect_uris: ['http://localhost'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'api',
    };
    await store.registerClient(newClient);

    // Size should remain 1000
    expect((store as any).clients.size).toBe(1000);

    // The oldest client (static-client-0) should be evicted (FIFO)
    const evictedClient = await store.getClient('static-client-0');
    expect(evictedClient).toBeUndefined();

    // The newest client should exist
    const newestClient = await store.getClient(`static-client-${limit}`);
    expect(newestClient).toBeDefined();
  });
});
