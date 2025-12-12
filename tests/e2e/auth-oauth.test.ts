/**
 * E2E tests for OAuth 2.0 authentication
 * 
 * Why: Verifies the complete OAuth flow including authorization, token exchange,
 * and token refresh functionality.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as path from 'path';
import { startStandaloneMockServer, MockServerInstance, getAvailablePort } from './utils/mock-server.js';
import { McpProcess } from './utils/mcp-process.js';

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

  describe('custom scheme redirect', () => {
    let mcp: McpProcess | undefined;
    let httpPort: number;

    const cursorRedirectUri = 'cursor://anysphere.cursor-mcp/oauth/callback';
    const clientState = 'custom-state-123';

    beforeAll(async () => {
      httpPort = await getAvailablePort();
    }, 15000);

    afterEach(async () => {
      await mcp?.stop();
      mcp = undefined;
    });

    it('should redirect callback to registered custom scheme client', async () => {
      const redirectUri = `http://127.0.0.1:${httpPort}/oauth/callback`;

      mcp = new McpProcess({
        transport: 'http',
        openapiSpecPath,
        profilePath,
        apiBaseUrl: mockServer.gitlabApiUrl,
        httpPort,
        oauth: {
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          redirectUri,
          authorizationEndpoint: `${mockServer.oauthUrl}/oauth/authorize`,
          tokenEndpoint: `${mockServer.oauthUrl}/oauth/token`,
        },
        env: {
          MCP4_OAUTH_ISSUER: mockServer.oauthUrl,
          MCP4_ALLOWED_ORIGINS: 'anysphere.cursor-mcp',
          MCP4_LOG_LEVEL: 'ERROR',
        },
      });

      await mcp.start();

      const registration = await fetch(`http://127.0.0.1:${httpPort}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [cursorRedirectUri] }),
      });

      expect(registration.status).toBe(201);
      const { client_id: clientId } = await registration.json() as { client_id: string };

      const authorizeResponse = await fetch(
        `http://127.0.0.1:${httpPort}/oauth/authorize?` +
        `response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(cursorRedirectUri)}` +
        `&code_challenge=test-challenge&code_challenge_method=S256` +
        `&scope=api&state=${clientState}`,
        { redirect: 'manual' }
      );

      expect(authorizeResponse.status).toBe(302);
      const providerLocation = authorizeResponse.headers.get('location');
      expect(providerLocation).toBeTruthy();

      const providerUrl = new URL(providerLocation!);
      const stateToken = providerUrl.searchParams.get('state');
      expect(stateToken).toBeTruthy();

      const providerRedirect = await fetch(providerUrl, { redirect: 'manual' });
      expect(providerRedirect.status).toBe(302);
      const callbackLocation = providerRedirect.headers.get('location');
      expect(callbackLocation).toBeTruthy();

      const callbackResponse = await fetch(callbackLocation!, { redirect: 'manual' });
      expect(callbackResponse.status).toBe(302);
      const finalLocation = callbackResponse.headers.get('location');
      expect(finalLocation).toBeTruthy();

      const finalUrl = new URL(finalLocation!);
      expect(finalUrl.protocol).toBe('cursor:');
      expect(finalUrl.host).toBe('anysphere.cursor-mcp');
      expect(finalUrl.searchParams.get('state')).toBe(clientState);
      expect(finalUrl.searchParams.get('code')).toBeTruthy();
    }, 20000);
  });
});
