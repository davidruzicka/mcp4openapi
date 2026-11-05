import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionCookieAuthManager } from './session-cookie-auth.js';
import { ConsoleLogger } from '../core/logger.js';
import { ValidationError } from '../core/errors.js';
import type { SessionCookieConfig } from '../types/profile.js';

describe('SessionCookieAuthManager SSRF Vulnerability', () => {
  const logger = new ConsoleLogger();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should BLOCK attempts to login to private IP (SSRF protection)', async () => {
    // 1. Setup manager with private IP endpoint
    const privateIpUrl = 'http://192.168.1.1/login';
    const config: SessionCookieConfig = {
      login_endpoint: privateIpUrl,
      username_field: 'username',
      username_from_env: 'TEST_USER',
      password_field: 'password',
      password_from_env: 'TEST_PASS',
      cookie_names: ['sid'],
      login_allowed_hosts: ['192.168.1.1'],
    };

    // Need env vars to build the request
    process.env.TEST_USER = 'user';
    process.env.TEST_PASS = 'pass';

    const manager = new SessionCookieAuthManager(config, 'http://example.com', logger);

    // 2. Mock fetch to ensure it's NOT called
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'set-cookie': 'sid=valid'
        })
      } as any;
    });

    // 3. Trigger prepareRequest (which triggers ensureLoggedIn) and expect it to fail
    const promise = manager.prepareRequest({ headers: {} } as any);
    await expect(promise).rejects.toThrow(ValidationError);
    await expect(promise).rejects.toThrow('IP address not allowed');

    // 4. Assert that fetch was NOT called
    expect(fetchMock).not.toHaveBeenCalled();

    delete process.env.TEST_USER;
    delete process.env.TEST_PASS;
  });
});
