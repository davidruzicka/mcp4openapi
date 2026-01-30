/**
 * Test simulating VS Code OAuth flow
 * 
 * VS Code behavior:
 * 1. Does NOT call /oauth/register
 * 2. Directly calls /oauth/authorize with client_id=mcp-proxy-client
 * 3. Expects redirect to external OAuth provider
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ExternalOAuthProvider } from '../auth/oauth-provider.js';
import type { OAuthConfig } from '../types/profile.js';
import { ConsoleLogger, LogLevel } from '../core/logger.js';

describe('VS Code OAuth Flow', () => {
  let provider: ExternalOAuthProvider;

  beforeEach(async () => {
    const config: OAuthConfig = {
      authorization_endpoint: 'https://gitlab.example.com/oauth/authorize',
      token_endpoint: 'https://gitlab.example.com/oauth/token',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uri: 'http://localhost:3000/oauth/callback',
      scopes: ['api', 'read_repository'],
    };

    const logger = new ConsoleLogger(LogLevel.ERROR);

    provider = new ExternalOAuthProvider(config, logger);
    
    // Trigger and wait for async initialization by accessing a property that requires it
    await provider.clientsStore.getClient('any-client-id');
  });

  it('should pre-register mcp-proxy-client during initialization', async () => {
    // Verify that mcp-proxy-client is available without prior registration
    const client = await provider.clientsStore.getClient('mcp-proxy-client');
    
    expect(client).toBeTruthy();
    expect(client?.client_id).toBe('mcp-proxy-client');
    expect(client?.client_secret).toBe('mcp-proxy-secret');
  });

  it('should allow any redirect_uri for pre-registered mcp-proxy-client', async () => {
    const client = await provider.clientsStore.getClient('mcp-proxy-client');
    
    expect(client).toBeTruthy();
    // redirect_uris should be empty array, allowing any URI
    expect(client?.redirect_uris).toEqual([]);
  });

  it('should have correct grant types for mcp-proxy-client', async () => {
    const client = await provider.clientsStore.getClient('mcp-proxy-client');
    
    expect(client).toBeTruthy();
    expect(client?.grant_types).toContain('authorization_code');
    expect(client?.grant_types).toContain('refresh_token');
  });
});

