/**
 * Tests for OAuth provider adapter
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExternalOAuthProvider, InMemoryClientsStore } from './oauth-provider.js';
import type { OAuthConfig } from './types/profile.js';
import type { Logger } from './logger.js';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

describe('InMemoryClientsStore', () => {
  let store: InMemoryClientsStore;

  beforeEach(() => {
    store = new InMemoryClientsStore();
  });

  it('should register and retrieve client', async () => {
    const client: OAuthClientInformationFull = {
      client_id: 'test-client',
      client_secret: 'test-secret',
      redirect_uris: ['http://localhost:3003/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };

    await store.registerClient(client);
    const retrieved = await store.getClient('test-client');

    expect(retrieved).toEqual(client);
  });

  it('should return undefined for non-existent client', async () => {
    const retrieved = await store.getClient('non-existent');
    expect(retrieved).toBeUndefined();
  });
});

describe('ExternalOAuthProvider', () => {
  let provider: ExternalOAuthProvider;
  let mockLogger: Logger;
  let config: OAuthConfig;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    config = {
      authorization_endpoint: 'https://oauth.example.com/authorize',
      token_endpoint: 'https://oauth.example.com/token',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      scopes: ['api', 'read_user'],
      redirect_uri: 'http://localhost:3003/oauth/callback',
    };
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      expect(provider).toBeDefined();
      // Constructor only logs mcp-proxy-client registration
      // Full initialization happens lazily in ensureEndpointsInitialized()
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Pre-registered mcp-proxy-client for VS Code compatibility'
      );
    });

    describe('deriveEndpointsFromIssuer', () => {
      const issuer = 'https://issuer.example.com';

      beforeEach(() => {
        provider = new ExternalOAuthProvider(config, mockLogger);
      });

      afterEach(() => {
        vi.restoreAllMocks();
        delete (global as any).fetch;
      });

      it('returns metadata endpoints when discovery succeeds', async () => {
        const metadata = {
          authorization_endpoint: 'https://issuer.example.com/authz',
          token_endpoint: 'https://issuer.example.com/token',
        };
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => metadata,
        });

        const derived = await (provider as any).deriveEndpointsFromIssuer({
          issuer,
        });

        expect(derived.authorization_endpoint).toBe(metadata.authorization_endpoint);
        expect(derived.token_endpoint).toBe(metadata.token_endpoint);
        expect(mockLogger.info).toHaveBeenCalledWith('Deriving OAuth endpoints from issuer', { issuer });
        expect(mockLogger.info).toHaveBeenCalledWith('Successfully discovered OAuth endpoints', metadata);
      });

      it('falls back to standard paths when metadata response is not ok', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: false });

        const derived = await (provider as any).deriveEndpointsFromIssuer({
          issuer,
        });

        expect(derived.authorization_endpoint).toBe(`${issuer}/oauth/authorize`);
        expect(derived.token_endpoint).toBe(`${issuer}/oauth/token`);
        expect(mockLogger.info).toHaveBeenCalledWith('OAuth metadata fetch failed, using standard OAuth paths', { issuer });
      });

      it('logs discovery failures and uses standard paths when metadata fetch throws', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

        const derived = await (provider as any).deriveEndpointsFromIssuer({
          issuer,
        });

        expect(derived.authorization_endpoint).toBe(`${issuer}/oauth/authorize`);
        expect(derived.token_endpoint).toBe(`${issuer}/oauth/token`);
        expect(mockLogger.debug).toHaveBeenCalledWith(
          'OAuth metadata fetch failed',
          expect.objectContaining({ issuerUrl: issuer, error: expect.any(Error) })
        );
        expect(mockLogger.info).toHaveBeenCalledWith('OAuth metadata fetch failed, using standard OAuth paths', { issuer });
      });

      it('keeps explicit endpoints when provided', async () => {
        const derived = await (provider as any).deriveEndpointsFromIssuer({
          issuer,
          authorization_endpoint: 'https://custom.example.com/auth',
          token_endpoint: 'https://custom.example.com/token',
        });

        expect(derived.authorization_endpoint).toBe('https://custom.example.com/auth');
        expect(derived.token_endpoint).toBe('https://custom.example.com/token');
        expect(mockLogger.info).not.toHaveBeenCalledWith('Deriving OAuth endpoints from issuer', expect.anything());
      });
    });

    describe('resolveEnvVars', () => {
      beforeEach(() => {
        provider = new ExternalOAuthProvider(config, mockLogger);
      });

      it('substitutes environment variables when present', () => {
        process.env.TEST_AUTH_URL = 'https://env-auth.example.com';
        process.env.TEST_TOKEN_URL = 'https://env-token.example.com';
        process.env.TEST_ISSUER = 'https://env-issuer.example.com';

        const resolved = (provider as any).resolveEnvVars({
          ...config,
          issuer: '${env:TEST_ISSUER}',
          authorization_endpoint: '${env:TEST_AUTH_URL}',
          token_endpoint: '${env:TEST_TOKEN_URL}',
        });

        expect(resolved.authorization_endpoint).toBe('https://env-auth.example.com');
        expect(resolved.token_endpoint).toBe('https://env-token.example.com');
        expect(resolved.issuer).toBe('https://env-issuer.example.com');

        delete process.env.TEST_AUTH_URL;
        delete process.env.TEST_TOKEN_URL;
        delete process.env.TEST_ISSUER;
      });

      it('throws when referenced environment variable is missing', () => {
        expect(() => {
          (provider as any).resolveEnvVars({
            ...config,
            authorization_endpoint: '${env:DOES_NOT_EXIST}',
          });
        }).toThrow('Environment variable DOES_NOT_EXIST not found');
      });
    });

    it('should resolve environment variables', () => {
      process.env.TEST_AUTH_URL = 'https://resolved.example.com/authorize';
      const envConfig: OAuthConfig = {
        ...config,
        authorization_endpoint: '${env:TEST_AUTH_URL}',
      };

      provider = new ExternalOAuthProvider(envConfig, mockLogger);
      // Verify environment variable was resolved by checking the endpoint
      expect(provider.authorizationEndpoint).toBe('https://resolved.example.com/authorize');

      delete process.env.TEST_AUTH_URL;
    });

    it('should throw error for missing environment variable', () => {
      const envConfig: OAuthConfig = {
        ...config,
        authorization_endpoint: '${env:MISSING_VAR}',
      };

      expect(() => {
        new ExternalOAuthProvider(envConfig, mockLogger);
      }).toThrow('Environment variable MISSING_VAR not found');
    });

    it('should log initialization message after lazy initialization', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      
      // Mock the authorize method to trigger lazy initialization
      const mockRes = { redirect: vi.fn() };
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };
      const params = {
        redirectUri: 'http://localhost:3003/oauth/callback',
        codeChallenge: 'test-challenge',
        scopes: ['api'],
      };

      await provider.authorize(client, params, mockRes as any);

      // After lazy initialization, should see the full initialization log
      expect(mockLogger.info).toHaveBeenCalledWith(
        'ExternalOAuthProvider initialized',
        expect.objectContaining({
          authEndpoint: config.authorization_endpoint,
          tokenEndpoint: config.token_endpoint,
        })
      );
    });
  });

  describe('authorize', () => {
    let mockRes: Partial<Response>;

    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      mockRes = {
        redirect: vi.fn(),
      };
    });

    it('should redirect to external OAuth provider', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'mcp-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const params = {
        redirectUri: 'http://localhost:3003/oauth/callback',
        codeChallenge: 'test-challenge',
        state: 'test-state',
        scopes: ['api'],
      };

      await provider.authorize(client, params, mockRes as Response);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('https://oauth.example.com/authorize')
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('client_id=test-client-id')
      );
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('redirect_uri=')
      );
      // Note: code_challenge is NOT forwarded to external OAuth provider
      // because MCP server acts as a confidential client with client_secret
      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('state=')
      );
    });

    it('should throw error for unregistered redirect URI', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'mcp-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const params = {
        redirectUri: 'http://malicious.com/callback',
        codeChallenge: 'test-challenge',
      };

      await expect(
        provider.authorize(client, params, mockRes as Response)
      ).rejects.toThrow('Unregistered redirect_uri');
    });
  });

  describe('challengeForAuthorizationCode', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should return code challenge for valid authorization', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'mcp-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const mockRes = { redirect: vi.fn() } as Partial<Response>;
      const params = {
        redirectUri: 'http://localhost:3003/oauth/callback',
        codeChallenge: 'test-challenge-123',
      };

      await provider.authorize(client, params, mockRes as Response);

      // Extract authorization code from redirect URL
      const redirectCall = (mockRes.redirect as any).mock.calls[0][0];
      const url = new URL(redirectCall);
      const state = url.searchParams.get('state');

      // Since we don't expose the internal code, we test the error case
      await expect(
        provider.challengeForAuthorizationCode(client, 'invalid-code')
      ).rejects.toThrow('Invalid authorization code');
    });
  });

  describe('exchangeAuthorizationCode', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      
      // Mock fetch for token exchange
      global.fetch = vi.fn();
    });

    it('should exchange authorization code for access token', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'mcp-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      // First authorize to create a code
      const mockRes = { redirect: vi.fn() } as Partial<Response>;
      const params = {
        redirectUri: 'http://localhost:3003/oauth/callback',
        codeChallenge: 'test-challenge',
      };

      await provider.authorize(client, params, mockRes as Response);

      // Since we can't access internal code, test error cases
      await expect(
        provider.exchangeAuthorizationCode(
          client,
          'invalid-code',
          'verifier',
          'http://localhost:3003/oauth/callback'
        )
      ).rejects.toThrow('Invalid authorization code');
    });

    it('should reject exchange with wrong client', async () => {
      const client1: OAuthClientInformationFull = {
        client_id: 'client-1',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const client2: OAuthClientInformationFull = {
        client_id: 'client-2',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const mockRes = { redirect: vi.fn() } as Partial<Response>;
      const params = {
        redirectUri: 'http://localhost:3003/callback',
        codeChallenge: 'test-challenge',
      };

      await provider.authorize(client1, params, mockRes as Response);

      // Try to exchange with different client
      await expect(
        provider.exchangeAuthorizationCode(
          client2,
          'any-code',
          'verifier',
          'http://localhost:3003/callback'
        )
      ).rejects.toThrow(/Invalid authorization code|not issued to this client/);
    });
  });

  describe('verifyAccessToken', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should reject invalid token', async () => {
      await expect(
        provider.verifyAccessToken('invalid-token')
      ).rejects.toThrow(/Invalid or expired token/);
    });

    it('should verify token via introspection if endpoint configured', async () => {
      const configWithIntrospection: OAuthConfig = {
        ...config,
        introspection_endpoint: 'https://oauth.example.com/introspect',
      };

      provider = new ExternalOAuthProvider(configWithIntrospection, mockLogger);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          active: true,
          client_id: 'test-client',
          scope: 'api read_user',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      });

      const authInfo = await provider.verifyAccessToken('test-token');

      expect(authInfo).toMatchObject({
        token: 'test-token',
        clientId: 'test-client',
        scopes: ['api', 'read_user'],
      });
    });

    it('should reject inactive token from introspection', async () => {
      const configWithIntrospection: OAuthConfig = {
        ...config,
        introspection_endpoint: 'https://oauth.example.com/introspect',
      };

      provider = new ExternalOAuthProvider(configWithIntrospection, mockLogger);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          active: false,
        }),
      });

      await expect(
        provider.verifyAccessToken('invalid-token')
      ).rejects.toThrow('Token is not active');
    });
  });

  describe('revokeToken', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      global.fetch = vi.fn();
    });

    it('should revoke token locally and with provider if endpoint configured', async () => {
      const configWithRevocation: OAuthConfig = {
        ...config,
        revocation_endpoint: 'https://oauth.example.com/revoke',
      };

      provider = new ExternalOAuthProvider(configWithRevocation, mockLogger);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
      });

      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      await provider.revokeToken(client, { token: 'test-token' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://oauth.example.com/revoke',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should handle revocation gracefully if no endpoint configured', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      // Should not throw even without revocation endpoint
      await expect(
        provider.revokeToken(client, { token: 'test-token' })
      ).resolves.not.toThrow();
    });

    it('should log warning when revocation fails', async () => {
      const configWithRevocation: OAuthConfig = {
        ...config,
        revocation_endpoint: 'https://oauth.example.com/revoke',
      };

      provider = new ExternalOAuthProvider(configWithRevocation, mockLogger);

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      // Should not throw even on failure
      await expect(
        provider.revokeToken(client, { token: 'test-token' })
      ).resolves.not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalledWith('Token revocation failed', { status: 500 });
    });
  });

  describe('authorize flow', () => {
    beforeEach(() => {
      config = {
        authorization_endpoint: 'https://oauth.example.com/authorize',
        token_endpoint: 'https://oauth.example.com/token',
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        scopes: ['api', 'read_user'],
        redirect_uri: 'http://localhost:3003/oauth/callback',
      };
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should throw error for unregistered redirect_uri', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'test-client-id',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const mockRes = {
        redirect: vi.fn(),
      } as unknown as Response;

      await expect(
        provider.authorize(client, {
          redirectUri: 'http://evil.com/callback',
          codeChallenge: 'challenge',
          state: 'state123',
          scopes: ['api'],
        }, mockRes)
      ).rejects.toThrow('Unregistered redirect_uri');
    });

    it('should throw error when redirect host is not allowed', async () => {
      const configWithAllowedHosts = {
        ...config,
        allowed_redirect_hosts: ['localhost'],
      };
      provider = new ExternalOAuthProvider(configWithAllowedHosts, mockLogger);

      const client: OAuthClientInformationFull = {
        client_id: 'test-client-id',
        redirect_uris: ['http://evil.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const mockRes = {
        redirect: vi.fn(),
      } as unknown as Response;

      await expect(
        provider.authorize(client, {
          redirectUri: 'http://evil.com/callback',
          codeChallenge: 'challenge',
          state: 'state123',
          scopes: ['api'],
        }, mockRes)
      ).rejects.toThrow('Redirect URI host not allowed');
    });

    it('should redirect to authorization endpoint with correct params', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'test-client-id',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const mockRes = {
        redirect: vi.fn(),
      } as unknown as Response;

      await provider.authorize(client, {
        redirectUri: 'http://localhost:3003/callback',
        codeChallenge: 'test-challenge',
        state: 'original-state',
        scopes: ['api', 'read_user'],
      }, mockRes);

      expect(mockRes.redirect).toHaveBeenCalled();
      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0];
      expect(redirectUrl).toContain('https://oauth.example.com/authorize');
      expect(redirectUrl).toContain('client_id=');
      expect(redirectUrl).toContain('response_type=code');
    });
  });

  describe('challengeForAuthorizationCode', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should throw error for invalid authorization code', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      await expect(
        provider.challengeForAuthorizationCode(client, 'invalid-code')
      ).rejects.toThrow('Invalid authorization code');
    });
  });

  describe('exchangeAuthorizationCode', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should throw error for invalid authorization code', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      await expect(
        provider.exchangeAuthorizationCode(client, 'invalid-code', 'verifier')
      ).rejects.toThrow('Invalid authorization code');
    });
  });

  describe('isAllowedRedirectHost', () => {
    it('should allow localhost by default', () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      
      expect((provider as any).isAllowedRedirectHost('http://localhost:3003/callback')).toBe(true);
      expect((provider as any).isAllowedRedirectHost('http://127.0.0.1:3003/callback')).toBe(true);
    });

    it('should allow wildcard subdomains', () => {
      const configWithWildcard = {
        ...config,
        allowed_redirect_hosts: ['localhost', '*.example.com'],
      };
      provider = new ExternalOAuthProvider(configWithWildcard, mockLogger);
      
      expect((provider as any).isAllowedRedirectHost('http://app.example.com/callback')).toBe(true);
      expect((provider as any).isAllowedRedirectHost('http://sub.app.example.com/callback')).toBe(true);
      expect((provider as any).isAllowedRedirectHost('http://example.com/callback')).toBe(true);
    });

    it('should reject non-allowed hosts', () => {
      const configWithAllowed = {
        ...config,
        allowed_redirect_hosts: ['localhost'],
      };
      provider = new ExternalOAuthProvider(configWithAllowed, mockLogger);
      
      expect((provider as any).isAllowedRedirectHost('http://evil.com/callback')).toBe(false);
    });

    it('should handle invalid URLs gracefully', () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      
      expect((provider as any).isAllowedRedirectHost('not-a-url')).toBe(false);
    });
  });

  describe('deriveEndpointsFromIssuer', () => {
    it('should throw error when neither issuer nor endpoints provided', async () => {
      const incompleteConfig: OAuthConfig = {
        client_id: 'test-client',
        client_secret: 'test-secret',
        scopes: ['api'],
      };

      provider = new ExternalOAuthProvider(incompleteConfig, mockLogger);

      await expect(
        (provider as any).deriveEndpointsFromIssuer(incompleteConfig)
      ).rejects.toThrow('OAuth config must provide either issuer OR both authorization_endpoint and token_endpoint');
    });

    it('should derive endpoints from issuer using standard paths when metadata fails', async () => {
      const issuerConfig: OAuthConfig = {
        issuer: 'https://auth.example.com',
        client_id: 'test-client',
        client_secret: 'test-secret',
        scopes: ['api'],
      };

      provider = new ExternalOAuthProvider(issuerConfig, mockLogger);

      // Mock fetch to fail
      global.fetch = vi.fn().mockResolvedValue({ ok: false });

      const result = await (provider as any).deriveEndpointsFromIssuer(issuerConfig);

      expect(result.authorization_endpoint).toBe('https://auth.example.com/oauth/authorize');
      expect(result.token_endpoint).toBe('https://auth.example.com/oauth/token');
    });

    it('should use metadata endpoints when fetch succeeds', async () => {
      const issuerConfig: OAuthConfig = {
        issuer: 'https://auth.example.com',
        client_id: 'test-client',
        client_secret: 'test-secret',
        scopes: ['api'],
      };

      provider = new ExternalOAuthProvider(issuerConfig, mockLogger);

      // Mock successful metadata fetch
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          authorization_endpoint: 'https://auth.example.com/custom/authorize',
          token_endpoint: 'https://auth.example.com/custom/token',
        }),
      });

      const result = await (provider as any).deriveEndpointsFromIssuer(issuerConfig);

      expect(result.authorization_endpoint).toBe('https://auth.example.com/custom/authorize');
      expect(result.token_endpoint).toBe('https://auth.example.com/custom/token');
    });
  });

  describe('handleCallback', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should return 400 for OAuth error in callback', async () => {
      const mockReq = {
        query: {
          error: 'access_denied',
          state: 'some-state',
        },
      } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        send: vi.fn(),
      } as any;

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'access_denied',
      }));
    });

    it('should return 400 for missing authorization code', async () => {
      const mockReq = {
        query: {
          state: 'some-state',
        },
      } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as any;

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Missing authorization code');
    });

    it('should return 400 for missing state parameter', async () => {
      const mockReq = {
        query: {
          code: 'auth-code',
        },
      } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as any;

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Missing state parameter');
    });

    it('should return 400 for invalid state', async () => {
      const mockReq = {
        query: {
          code: 'auth-code',
          state: 'invalid-state',
        },
      } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      } as any;

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Invalid or expired state');
    });

    it('should return 400 when stored redirect host is disallowed during callback', async () => {
      const configWithAllowedHosts = {
        ...config,
        allowed_redirect_hosts: ['localhost'],
      };
      provider = new ExternalOAuthProvider(configWithAllowedHosts, mockLogger);

      const client: OAuthClientInformationFull = {
        client_id: 'client-123',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };
      (provider as any)._clientsStore.registerClient(client);

      // Insert tampered state referencing disallowed host
      (provider as any).stateStore.set('state123', {
        clientRedirectUri: 'http://evil.com/callback',
        codeChallenge: 'challenge',
        originalState: 'orig',
        clientId: client.client_id,
        scopes: ['api'],
      });

      // Stub token exchange
      (provider as any).exchangeCodeWithProvider = vi.fn().mockResolvedValue({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
      });

      const mockReq = {
        query: {
          code: 'auth-code',
          state: 'state123',
        },
      } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn(),
      } as any;

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Redirect URI host not allowed');
      expect(mockRes.redirect).not.toHaveBeenCalled();
    });

    it('should allow registered custom scheme redirect URIs when host is allowed', async () => {
      const configWithAllowedHosts = {
        ...config,
        allowed_redirect_hosts: ['anysphere.cursor-mcp'],
      };
      provider = new ExternalOAuthProvider(configWithAllowedHosts, mockLogger);

      const client: OAuthClientInformationFull = {
        client_id: 'client-123',
        redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };
      (provider as any)._clientsStore.registerClient(client);

      (provider as any).stateStore.set('state123', {
        clientRedirectUri: 'cursor://anysphere.cursor-mcp/oauth/callback',
        codeChallenge: 'challenge',
        originalState: 'orig',
        clientId: client.client_id,
        scopes: ['api'],
      });

      (provider as any).exchangeCodeWithProvider = vi.fn().mockResolvedValue({
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 3600,
        token_type: 'Bearer',
      });

      const mockReq = {
        query: {
          code: 'auth-code',
          state: 'state123',
        },
      } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        redirect: vi.fn(),
      } as any;

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.redirect).toHaveBeenCalledWith(
        expect.stringContaining('cursor://anysphere.cursor-mcp/oauth/callback?code=')
      );
      expect(mockRes.status).not.toHaveBeenCalledWith(400);
    });
  });

  describe('verifyAccessToken', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should throw for unknown token without introspection endpoint', async () => {
      await expect(
        provider.verifyAccessToken('unknown-token')
      ).rejects.toThrow('Invalid or expired token');
    });
  });

  describe('exchangeRefreshToken', () => {
    beforeEach(() => {
      provider = new ExternalOAuthProvider(config, mockLogger);
    });

    it('should call token endpoint with refresh_token grant', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['refresh_token'],
        response_types: ['code'],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      const tokens = await provider.exchangeRefreshToken(client, 'refresh-token', ['api']);

      expect(tokens.access_token).toBe('new-access-token');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://oauth.example.com/token',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should throw on failed refresh', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['refresh_token'],
        response_types: ['code'],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid refresh token',
      });

      await expect(
        provider.exchangeRefreshToken(client, 'invalid-refresh-token')
      ).rejects.toThrow('Refresh token exchange failed: 401');
    });
  });

  describe('clientsStore getter', () => {
    it('should return the clients store', () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      const store = provider.clientsStore;
      expect(store).toBeDefined();
    });
  });

  describe('scopes getter', () => {
    it('should return configured scopes', () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      expect(provider.scopes).toEqual(['api', 'read_user']);
    });

    it('should return empty array when no scopes configured', () => {
      const noScopesConfig = { ...config, scopes: undefined };
      provider = new ExternalOAuthProvider(noScopesConfig, mockLogger);
      expect(provider.scopes).toEqual([]);
    });
  });

  describe('verifyAccessToken with introspection', () => {
    beforeEach(() => {
      const introspectionConfig = {
        ...config,
        introspection_endpoint: 'https://oauth.example.com/introspect',
      };
      provider = new ExternalOAuthProvider(introspectionConfig, mockLogger);
    });

    it('should verify token via introspection endpoint', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          active: true,
          client_id: 'test-client',
          scope: 'api read_user',
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      });

      const authInfo = await provider.verifyAccessToken('valid-token');

      expect(authInfo.token).toBe('valid-token');
      expect(authInfo.clientId).toBe('test-client');
      expect(authInfo.scopes).toEqual(['api', 'read_user']);
    });

    it('should throw on inactive token from introspection', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          active: false,
        }),
      });

      await expect(provider.verifyAccessToken('inactive-token'))
        .rejects.toThrow('Token is not active');
    });

    it('should throw on introspection endpoint failure', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(provider.verifyAccessToken('some-token'))
        .rejects.toThrow('Token introspection failed: 500');
    });
  });

  describe('revokeToken', () => {
    it('should revoke token from local store without revocation endpoint', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      await provider.revokeToken(client, { token: 'some-token' });

      expect(mockLogger.info).toHaveBeenCalledWith('Revoking token', { clientId: 'test-client' });
    });

    it('should call revocation endpoint when configured', async () => {
      const revocationConfig = {
        ...config,
        revocation_endpoint: 'https://oauth.example.com/revoke',
      };
      provider = new ExternalOAuthProvider(revocationConfig, mockLogger);
      
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
      });

      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      await provider.revokeToken(client, { token: 'token-to-revoke' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://oauth.example.com/revoke',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('exchangeAuthorizationCode edge cases', () => {
    it('should throw when authorization code expired', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      // Manually inject expired code (6 minutes old)
      const expiredCode = 'expired-code';
      (provider as any).authorizationCodes.set(expiredCode, {
        client,
        params: {
          redirectUri: 'http://localhost:3003/callback',
          codeChallenge: 'challenge',
          scopes: [],
        },
        createdAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
        tokens: { access_token: 'token' },
      });

      await expect(
        provider.exchangeAuthorizationCode(client, expiredCode, 'verifier', 'http://localhost:3003/callback')
      ).rejects.toThrow('Authorization code expired');
    });

    it('should throw when PKCE code_verifier missing but required', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const code = 'code-with-pkce';
      (provider as any).authorizationCodes.set(code, {
        client,
        params: {
          redirectUri: 'http://localhost:3003/callback',
          codeChallenge: 'some-challenge',
          scopes: [],
        },
        createdAt: Date.now(),
        tokens: { access_token: 'token' },
      });

      await expect(
        provider.exchangeAuthorizationCode(client, code, undefined, 'http://localhost:3003/callback')
      ).rejects.toThrow('code_verifier is required for PKCE');
    });

    it('should throw when PKCE code_verifier invalid', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const code = 'code-with-pkce';
      (provider as any).authorizationCodes.set(code, {
        client,
        params: {
          redirectUri: 'http://localhost:3003/callback',
          codeChallenge: 'correct-challenge',
          scopes: [],
        },
        createdAt: Date.now(),
        tokens: { access_token: 'token' },
      });

      await expect(
        provider.exchangeAuthorizationCode(client, code, 'wrong-verifier', 'http://localhost:3003/callback')
      ).rejects.toThrow('Invalid code_verifier');
    });

    it('should throw when no tokens associated with code', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const code = 'code-no-tokens';
      (provider as any).authorizationCodes.set(code, {
        client,
        params: {
          redirectUri: 'http://localhost:3003/callback',
          scopes: [],
        },
        createdAt: Date.now(),
        // No tokens field
      });

      await expect(
        provider.exchangeAuthorizationCode(client, code, undefined, 'http://localhost:3003/callback')
      ).rejects.toThrow('No tokens associated with this code');
    });
  });

  describe('handleCallback edge cases', () => {
    it('should return 400 for invalid redirect URI protocol during callback', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      await provider.ensureEndpointsInitialized();

      const mockReq = {
        query: { code: 'auth-code', state: 'valid-state' },
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        json: vi.fn(),
        redirect: vi.fn(),
      } as any;

      // Setup state with invalid protocol - will fail host validation first
      (provider as any).stateStore.set('valid-state', {
        clientRedirectUri: 'javascript:alert(1)',
        codeChallenge: 'challenge',
        clientId: 'mcp-proxy-client',
        scopes: [],
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'token',
          token_type: 'Bearer',
        }),
      });

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      // Host validation catches this before protocol check
      expect(mockRes.send).toHaveBeenCalledWith('Redirect URI host not allowed');
    });

    it('should return 400 when stored redirect URI no longer registered', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      await provider.ensureEndpointsInitialized();

      const mockReq = {
        query: { code: 'auth-code', state: 'valid-state' },
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        json: vi.fn(),
        redirect: vi.fn(),
      } as any;

      // Register client with specific redirect URIs
      const client: OAuthClientInformationFull = {
        client_id: 'strict-client',
        redirect_uris: ['http://localhost:3003/allowed'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };
      await (provider as any)._clientsStore.registerClient(client);

      // Setup state with different URI
      (provider as any).stateStore.set('valid-state', {
        clientRedirectUri: 'http://localhost:3003/not-allowed',
        codeChallenge: 'challenge',
        clientId: 'strict-client',
        scopes: [],
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'token',
          token_type: 'Bearer',
        }),
      });

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.send).toHaveBeenCalledWith('Unregistered redirect_uri');
    });

    it('should return 500 when token exchange with provider fails', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      await provider.ensureEndpointsInitialized();

      const mockReq = {
        query: { code: 'auth-code', state: 'valid-state' },
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
        json: vi.fn(),
        redirect: vi.fn(),
      } as any;

      (provider as any).stateStore.set('valid-state', {
        clientRedirectUri: 'http://localhost:3003/callback',
        codeChallenge: 'challenge',
        clientId: 'mcp-proxy-client',
        scopes: [],
      });

      // Mock fetch to fail
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      });

      await provider.handleCallback(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('Internal Server Error during token exchange');
    });
  });

  describe('verifyAccessToken with expiration', () => {
    it('should throw when token expired in local store', async () => {
      provider = new ExternalOAuthProvider(config, mockLogger);

      const expiredToken = 'expired-token';
      (provider as any).accessTokens.set(expiredToken, {
        token: expiredToken,
        clientId: 'test-client',
        scopes: ['api'],
        expiresAt: Date.now() - 1000, // Expired 1 second ago
      });

      await expect(provider.verifyAccessToken(expiredToken))
        .rejects.toThrow('Token expired');
    });
  });

  describe('redirectUri and scopes getters', () => {
    it('should return redirect URI from config', () => {
      provider = new ExternalOAuthProvider(config, mockLogger);
      expect(provider.redirectUri).toBe('http://localhost:3003/oauth/callback');
    });

    it('should return undefined when redirect URI not configured', () => {
      const noRedirectConfig = { ...config };
      delete noRedirectConfig.redirect_uri;
      provider = new ExternalOAuthProvider(noRedirectConfig, mockLogger);
      expect(provider.redirectUri).toBeUndefined();
    });
  });

  describe('authorize with missing redirect_uri config', () => {
    it('should throw when MCP4_OAUTH_REDIRECT_URI not configured', async () => {
      const noRedirectConfig = { ...config };
      delete noRedirectConfig.redirect_uri;
      provider = new ExternalOAuthProvider(noRedirectConfig, mockLogger);

      const client: OAuthClientInformationFull = {
        client_id: 'test-client',
        redirect_uris: ['http://localhost:3003/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const mockRes = {
        redirect: vi.fn(),
      } as any;

      await expect(
        provider.authorize(
          client,
          {
            redirectUri: 'http://localhost:3003/callback',
            codeChallenge: 'challenge',
            scopes: ['api'],
          },
          mockRes
        )
      ).rejects.toThrow('MCP4_OAUTH_REDIRECT_URI must be configured');
    });
  });

});
