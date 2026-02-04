import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExternalOAuthProvider } from './oauth-provider.js';
import { ConsoleLogger } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';

describe('ExternalOAuthProvider SSRF Vulnerability', () => {
  const logger = new ConsoleLogger();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should BLOCK attempts to fetch from private IP (SSRF protection)', async () => {
    // 1. Setup provider with private IP endpoint
    const privateIpUrl = 'http://192.168.1.1/oauth/token';
    const provider = new ExternalOAuthProvider({
      issuer: undefined,
      authorization_endpoint: 'http://example.com/auth',
      token_endpoint: privateIpUrl,
      client_id: 'test',
      client_secret: 'test',
      redirect_uri: 'http://localhost/callback'
    }, logger);

    // 2. Mock fetch to ensure it's NOT called
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({ access_token: 'valid', token_type: 'Bearer' }),
      } as any;
    });

    // 3. Trigger the token exchange and expect it to fail
    const code = 'auth-code';

    await expect(
      (provider as any).exchangeCodeWithProvider(code, undefined, 'http://localhost/callback')
    ).rejects.toThrow(ValidationError);

    await expect(
      (provider as any).exchangeCodeWithProvider(code, undefined, 'http://localhost/callback')
    ).rejects.toThrow('IP address not allowed');

    // 4. Assert that fetch was NOT called
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
