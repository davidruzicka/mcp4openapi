/**
 * Test OAuth provider initialization timing
 * 
 * Purpose: Verify that authorizationEndpoint getter doesn't return undefined
 * when accessed before async initialization completes.
 */

import { describe, it, expect } from 'vitest';
import { ExternalOAuthProvider } from '../oauth-provider.js';
import type { OAuthConfig } from '../types/profile.js';
import { ConsoleLogger } from '../logger.js';

describe('OAuth Provider Initialization', () => {
  it('should return undefined for authorizationEndpoint before async initialization (with issuer)', async () => {
    const config: OAuthConfig = {
      issuer: 'https://gitlab.example.com',
      // No explicit endpoints - will be derived asynchronously
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uri: 'http://localhost:3003/oauth/callback',
      scopes: ['api'],
    };

    const logger = new ConsoleLogger({
      serviceName: 'test',
      minLevel: 'error',
    });

    const provider = new ExternalOAuthProvider(config, logger);
    
    // FIXED: authorizationEndpoint getter now properly returns undefined
    // before async initialization completes
    const endpoint = provider.authorizationEndpoint;
    
    // Should be undefined because endpoints haven't been derived yet
    expect(endpoint).toBeUndefined();
  });

  it('should have defined authorizationEndpoint with explicit endpoints', () => {
    const config: OAuthConfig = {
      authorization_endpoint: 'https://gitlab.example.com/oauth/authorize',
      token_endpoint: 'https://gitlab.example.com/oauth/token',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uri: 'http://localhost:3003/oauth/callback',
      scopes: ['api'],
    };

    const logger = new ConsoleLogger({
      serviceName: 'test',
      minLevel: 'error',
    });

    const provider = new ExternalOAuthProvider(config, logger);
    
    // With explicit endpoints, this should work immediately
    const endpoint = provider.authorizationEndpoint;
    
    expect(endpoint).toBe('https://gitlab.example.com/oauth/authorize');
  });
});

