
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalOAuthProvider } from './oauth-provider.js';
import { PROXY_CREDENTIALS } from '../core/constants.js';
import { ConsoleLogger } from '../core/logger.js';
import type { Request, Response } from 'express';

describe('ExternalOAuthProvider Security', () => {
  let provider: ExternalOAuthProvider;
  let mockRes: Partial<Response>;
  const logger = new ConsoleLogger();

  beforeEach(() => {
    provider = new ExternalOAuthProvider({
      authorization_endpoint: 'https://auth.example.com/authorize',
      token_endpoint: 'https://auth.example.com/token',
      client_id: 'test-client',
      client_secret: 'test-secret',
      redirect_uri: 'http://localhost:3000/callback',
      allowed_redirect_hosts: ['localhost']
    }, logger);

    mockRes = {
      redirect: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  it('should BLOCK javascript: scheme in authorize even if hostname matches allowed host', async () => {
    const maliciousUri = 'javascript://localhost/%0aalert(1)';
    const client = await provider.clientsStore.getClient(PROXY_CREDENTIALS.CLIENT_ID);

    expect(client).toBeDefined();

    // Should throw now
    await expect(provider.authorize(client!, {
      redirectUri: maliciousUri,
      responseType: 'code',
      clientId: PROXY_CREDENTIALS.CLIENT_ID,
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
      state: 'state'
    }, mockRes as Response)).rejects.toThrow('Redirect URI host not allowed');

    expect(mockRes.redirect).not.toHaveBeenCalled();
  });

  it('should BLOCK javascript: scheme in callback if state was somehow tampered or stored', async () => {
    // Manually inject malicious state to simulate bypass or tampering
    const maliciousUri = 'javascript://localhost/%0aalert(1)';
    const stateToken = 'tampered-state';

    // Use private stateStore to inject bad state
    (provider as any).stateStore.set(stateToken, {
      clientRedirectUri: maliciousUri,
      clientId: PROXY_CREDENTIALS.CLIENT_ID,
      createdAt: Date.now()
    });

    const mockReq = {
      query: {
        code: 'auth-code',
        state: stateToken
      }
    } as unknown as Request;

    // Mock token exchange to succeed (if it gets that far)
    vi.spyOn(provider as any, 'exchangeCodeWithProvider').mockResolvedValue({
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 3600
    });

    await provider.handleCallback(mockReq, mockRes as Response);

    // Verify it blocked the redirect and returned 400
    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.send).toHaveBeenCalledWith('Redirect URI host not allowed');
    expect(mockRes.redirect).not.toHaveBeenCalled();
  });
});
