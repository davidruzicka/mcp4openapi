import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionCookieAuthManager } from './session-cookie-auth.js';
import type { SessionCookieConfig } from '../types/profile.js';
import { SSRFValidator } from '../security/ssrf-validator.js';
import { ValidationError } from '../core/errors.js';

describe('SessionCookieAuthManager SSRF', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('validates login_endpoint using SSRFValidator during ensureLoggedIn', async () => {
    // Setup environment vars required by SessionCookieAuthManager
    process.env.TEST_USER = 'test-user';
    process.env.TEST_PASS = 'test-pass';

    const config: SessionCookieConfig = {
      cookie_names: ['sid'],
      login_endpoint: 'http://169.254.169.254/latest/meta-data/', // typical AWS metadata IP
      username_field: 'username',
      password_field: 'password',
      username_from_env: 'TEST_USER',
      login_allowed_hosts: ['169.254.169.254'],
      password_from_env: 'TEST_PASS',
    };

    // Instantiate an SSRFValidator (no mocking of the internal logic, we want the real validation)
    const ssrfValidator = new SSRFValidator({
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as any);

    const manager = new SessionCookieAuthManager(
      config,
      'https://api.example.com',
      undefined,
      1000,
      ssrfValidator,
    );

    // ensureLoggedIn is called during prepareRequest if there are no usable cookies
    await expect(manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).rejects.toThrow(ValidationError);
  });

  it('passes SSRF validation for valid public endpoints', async () => {
    process.env.TEST_USER = 'test-user';
    process.env.TEST_PASS = 'test-pass';

    // We must mock fetch to prevent actual network calls on successful validation
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      const headers = new Headers();
      headers.set('set-cookie', 'sid=testcookie');
      return new Response('ok', { status: 200, headers });
    });

    const config: SessionCookieConfig = {
      cookie_names: ['sid'],
      login_endpoint: 'https://login.example.com/auth', // public IP
      username_field: 'username',
      password_field: 'password',
      username_from_env: 'TEST_USER',
      password_from_env: 'TEST_PASS',
      login_allowed_hosts: ['login.example.com'], // allow absolute external URL
    };

    const ssrfValidator = new SSRFValidator({
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as any);

    // Mock DNS lookup to return a public IP for login.example.com to avoid real DNS query
    const dnsSpy = vi.spyOn(ssrfValidator as any, 'lookupAllIpAddresses').mockResolvedValue(['93.184.216.34']);

    const manager = new SessionCookieAuthManager(
      config,
      'https://api.example.com',
      undefined,
      1000,
      ssrfValidator,
    );

    const credentials = await manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    });

    expect(credentials.headers).toBeDefined();
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
    dnsSpy.mockRestore();
  });
});
