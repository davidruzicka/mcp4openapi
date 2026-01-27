
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExternalOAuthProvider } from './oauth-provider.js';
import type { OAuthConfig } from './types/profile.js';
import type { Logger } from './logger.js';
import type { Response } from 'express';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash } from 'node:crypto';

describe('ExternalOAuthProvider Security', () => {
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
      scopes: ['api'],
      redirect_uri: 'http://localhost:3003/oauth/callback',
    };

    provider = new ExternalOAuthProvider(config, mockLogger);

    // Mock fetch for token exchange
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }),
    });
  });

  describe('Random Token Generation', () => {
    it('should use high-entropy hex string for state token instead of UUID', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'mcp-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      const mockRes = {
        redirect: vi.fn(),
      } as unknown as Response;

      await provider.authorize(client, {
        redirectUri: 'http://localhost:3003/oauth/callback',
        codeChallenge: 'challenge',
        scopes: ['api'],
      }, mockRes);

      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0];
      const url = new URL(redirectUrl);
      const state = url.searchParams.get('state');

      expect(state).toBeDefined();
      // UUID has dashes: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      // Hex string (randomBytes) does not have dashes
      // We expect NO dashes for our new secure implementation
      // NOTE: This test will FAIL until we implement the fix
      // But we can check for length > 36 (UUID is 36 chars)
      // randomBytes(32).toString('hex') is 64 chars.

      // For now, let's just log it to verify manually or check against regex
      // If we haven't applied the fix yet, this expects UUID format.
      // After fix, it should be hex string.
      // Let's assert it is a non-empty string for now, and refine after fix?
      // No, I want to verify the fix works.

      // This assertion assumes the FIX IS APPLIED.
      // Since I am writing the test first, I will comment out the strict check or expect it to fail if I ran it now.
      // But I will run this AFTER applying changes in step 4.
      // So I can write the expectation for the FIX.

      expect(state).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex = 64 chars
    });
  });

  describe('PKCE Verification', () => {
    it('should verify correct code verifier', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'mcp-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      // 1. Authorize to generate state and code challenge
      const verifier = 'secure-random-verifier-string';
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      const mockRes = { redirect: vi.fn() } as unknown as Response;

      await provider.authorize(client, {
        redirectUri: 'http://localhost:3003/oauth/callback',
        codeChallenge: challenge,
        scopes: ['api'],
      }, mockRes);

      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0];
      const url = new URL(redirectUrl);
      const state = url.searchParams.get('state')!;

      // 2. Handle callback to generate internal code
      const mockReq = {
        query: { code: 'external-code', state },
      } as any;
      const mockResCallback = {
        status: vi.fn().mockReturnThis(),
        redirect: vi.fn(),
        send: vi.fn(),
      } as any;

      // Register client so handleCallback can find it
      await provider.clientsStore.registerClient(client);

      // Access private method or simulate callback handling?
      // authorize() puts it in stateStore.
      // handleCallback() moves it to authorizationCodes.

      await provider.handleCallback(mockReq, mockResCallback);

      const callbackRedirectUrl = (mockResCallback.redirect as any).mock.calls[0][0];
      const callbackUrl = new URL(callbackRedirectUrl);
      const internalCode = callbackUrl.searchParams.get('code')!;

      // 3. Exchange internal code
      const tokens = await provider.exchangeAuthorizationCode(
        client,
        internalCode,
        verifier,
        'http://localhost:3003/oauth/callback'
      );

      expect(tokens).toBeDefined();
      expect(tokens.access_token).toBe('access-token');
    });

    it('should reject incorrect code verifier', async () => {
      const client: OAuthClientInformationFull = {
        client_id: 'mcp-client',
        redirect_uris: ['http://localhost:3003/oauth/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      };

      // 1. Authorize
      const verifier = 'secure-random-verifier-string';
      const challenge = createHash('sha256').update(verifier).digest('base64url');

      const mockRes = { redirect: vi.fn() } as unknown as Response;

      await provider.authorize(client, {
        redirectUri: 'http://localhost:3003/oauth/callback',
        codeChallenge: challenge,
        scopes: ['api'],
      }, mockRes);

      const redirectUrl = (mockRes.redirect as any).mock.calls[0][0];
      const url = new URL(redirectUrl);
      const state = url.searchParams.get('state')!;

      // 2. Handle callback
      const mockReq = {
        query: { code: 'external-code', state },
      } as any;
      const mockResCallback = {
        status: vi.fn().mockReturnThis(),
        redirect: vi.fn(),
        send: vi.fn(),
      } as any;

      // Register client so handleCallback can find it
      await provider.clientsStore.registerClient(client);

      await provider.handleCallback(mockReq, mockResCallback);

      const callbackRedirectUrl = (mockResCallback.redirect as any).mock.calls[0][0];
      const callbackUrl = new URL(callbackRedirectUrl);
      const internalCode = callbackUrl.searchParams.get('code')!;

      // 3. Exchange with WRONG verifier
      await expect(
        provider.exchangeAuthorizationCode(
          client,
          internalCode,
          'wrong-verifier',
          'http://localhost:3003/oauth/callback'
        )
      ).rejects.toThrow('Invalid code_verifier');
    });
  });
});
