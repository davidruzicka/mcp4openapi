import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ExternalOAuthProvider } from './oauth-provider.js';
import type { OAuthConfig } from '../types/profile.js';
import type { Logger } from '../core/logger.js';
import { createHash, timingSafeEqual } from 'node:crypto';

// Mock timingSafeEqual
vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    timingSafeEqual: vi.fn((a, b) => {
        return actual.timingSafeEqual(a, b);
    }),
  };
});

describe('OAuth PKCE Security', () => {
  let provider: ExternalOAuthProvider;
  let mockLogger: Logger;
  let config: OAuthConfig;

  beforeEach(() => {
    vi.clearAllMocks();

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should use crypto.timingSafeEqual for PKCE verification', async () => {
    const client = {
      client_id: 'test-client',
      redirect_uris: ['http://localhost:3003/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };

    // 1. Setup stored code with challenge
    const verifier = 'test-verifier-string-must-be-long-enough';
    // Calculate expected challenge
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = 'auth-code';

    // Inject into internal store
    (provider as any).authorizationCodes.set(code, {
      client,
      params: {
        redirectUri: 'http://localhost:3003/callback',
        codeChallenge: challenge,
        scopes: [],
      },
      createdAt: Date.now(),
      tokens: { access_token: 'token' },
    });

    // 2. Exchange code (valid verifier)
    await provider.exchangeAuthorizationCode(
      client as any,
      code,
      verifier,
      'http://localhost:3003/callback'
    );

    // 3. Verify timingSafeEqual was called
    // We check the imported function which should be the mock
    expect(timingSafeEqual).toHaveBeenCalled();
  });

  it('should reject invalid verifier', async () => {
    const client = {
      client_id: 'test-client',
      redirect_uris: ['http://localhost:3003/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };

    const verifier = 'test-verifier-string-must-be-long-enough';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const code = 'auth-code-invalid';

    (provider as any).authorizationCodes.set(code, {
      client,
      params: {
        redirectUri: 'http://localhost:3003/callback',
        codeChallenge: challenge,
        scopes: [],
      },
      createdAt: Date.now(),
      tokens: { access_token: 'token' },
    });

    await expect(
        provider.exchangeAuthorizationCode(
            client as any,
            code,
            'wrong-verifier',
            'http://localhost:3003/callback'
        )
    ).rejects.toThrow('Invalid code_verifier');
  });
});
