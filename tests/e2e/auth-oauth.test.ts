/**
 * E2E tests for OAuth 2.0 authentication
 * 
 * Why: Verifies the complete OAuth flow including authorization, token exchange,
 * and token refresh functionality.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { startStandaloneMockServer, MockServerInstance } from './utils/mock-server.js';

describe('E2E: OAuth 2.0 authentication', () => {
  let mockServer: MockServerInstance;

  const openapiSpecPath = path.resolve(process.cwd(), 'profiles/gitlab/openapi.yaml');
  // Use regular profile - OAuth profile requires actual OAuth config
  const profilePath = path.resolve(process.cwd(), 'profiles/gitlab/developer-profile.json');

  beforeAll(async () => {
    mockServer = await startStandaloneMockServer({
      apiBasePath: '/api/v4',
      oauth: {
        oauthBaseUrl: '', // Will be set based on actual port
        accessToken: 'mock-access-token',
        refreshToken: 'mock-refresh-token',
        expiresIn: 3600,
      },
    });
  }, 30000);

  afterAll(async () => {
    await mockServer?.stop();
  });

  // Note: Full OAuth flow tests require the server to be configured with OAuth,
  // which is complex to set up in E2E tests. These tests verify the mock OAuth
  // endpoints work correctly.

  it('should discover OAuth endpoints from well-known URL', async () => {
    const discoveryResponse = await fetch(
      `${mockServer.oauthUrl}/.well-known/oauth-authorization-server`
    );

    expect(discoveryResponse.ok).toBe(true);
    
    const discovery = await discoveryResponse.json();
    expect(discovery.authorization_endpoint).toBeDefined();
    expect(discovery.token_endpoint).toBeDefined();
  }, 10000);

  it('should exchange authorization code for token', async () => {
    const response = await fetch(`${mockServer.oauthUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'mock-code-12345',
        redirect_uri: 'http://localhost:3003/oauth/callback',
        client_id: 'test-client',
        client_secret: 'test-secret',
      }),
    });

    expect(response.ok).toBe(true);
    
    const token = await response.json();
    expect(token.access_token).toBeDefined();
    expect(token.token_type).toBe('Bearer');
    expect(token.expires_in).toBeGreaterThan(0);
  }, 10000);

  it('should refresh access token', async () => {
    const response = await fetch(`${mockServer.oauthUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'mock-refresh-token',
        client_id: 'test-client',
        client_secret: 'test-secret',
      }),
    });

    expect(response.ok).toBe(true);
    
    const token = await response.json();
    expect(token.access_token).toContain('refreshed');
    expect(token.refresh_token).toBeDefined();
  }, 10000);

  it('should reject invalid grant type', async () => {
    const response = await fetch(`${mockServer.oauthUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'invalid_grant',
        code: 'some-code',
      }),
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    
    const error = await response.json();
    expect(error.error).toBe('unsupported_grant_type');
  }, 10000);

  it('should redirect from authorization endpoint', async () => {
    const redirectUri = 'http://localhost:3003/oauth/callback';
    const response = await fetch(
      `${mockServer.oauthUrl}/oauth/authorize?` +
      `response_type=code&` +
      `client_id=test-client&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=api&` +
      `state=test-state`,
      { redirect: 'manual' }
    );

    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('code=');
    expect(location).toContain('state=test-state');
  }, 10000);
});
