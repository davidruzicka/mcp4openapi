import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryClientsStore } from './oauth-provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

describe('InMemoryClientsStore DoS', () => {
  let store: InMemoryClientsStore;

  beforeEach(() => {
    store = new InMemoryClientsStore();
  });

  it('should enforce max clients limit', async () => {
    // 1. Register static clients (like VS Code proxy)
    const staticClient: OAuthClientInformationFull = {
      client_id: 'mcp-proxy-client',
      redirect_uris: [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };
    await store.registerClient(staticClient);

    // 2. Register 2000 dynamic clients
    for (let i = 0; i < 2000; i++) {
      const dynamicClient: OAuthClientInformationFull = {
        client_id: `mcp-client-${i}`,
        redirect_uris: [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };
      await store.registerClient(dynamicClient);
    }

    // Size should be capped at 1000
    expect((store as any).clients.size).toBe(1000);

    // Verify static client is still there (not evicted)
    const retrievedStatic = await store.getClient('mcp-proxy-client');
    expect(retrievedStatic).toBeDefined();

    // Verify oldest dynamic clients are evicted
    // mcp-client-0 should be evicted
    const oldClient = await store.getClient('mcp-client-0');
    expect(oldClient).toBeUndefined();

    // Verify newest dynamic clients are present
    // mcp-client-1999 should be present
    const newClient = await store.getClient('mcp-client-1999');
    expect(newClient).toBeDefined();
  });

  it('should evict oldest client if all are static (fallback)', async () => {
     // Register 1001 static clients
    for (let i = 0; i < 1001; i++) {
      const client: OAuthClientInformationFull = {
        client_id: `static-client-${i}`,
        redirect_uris: [],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };
      await store.registerClient(client);
    }

    expect((store as any).clients.size).toBe(1000);

    // oldest should be evicted
    const oldClient = await store.getClient('static-client-0');
    expect(oldClient).toBeUndefined();

    // newest should be present
    const newClient = await store.getClient('static-client-1000');
    expect(newClient).toBeDefined();
  });
});
