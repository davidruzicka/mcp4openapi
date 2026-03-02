import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionCookieAuthManager,
  SessionCookieCoordinator,
  SessionCookieJar,
  SetCookieParser,
} from './session-cookie-auth.js';
import { HttpClient, InterceptorChain } from './interceptors.js';
import type { InterceptorConfig } from '../types/profile.js';
import {
  ConfigurationError,
  SessionCookieBackoffError,
  SessionCookieMissingError,
} from '../core/errors.js';
import type { SSRFValidator } from '../security/ssrf-validator.js';

const mockSSRFValidator = {
  validate: async () => {},
} as unknown as SSRFValidator;

const originalEnv = { ...process.env };

function createSessionCookieConfig(overrides: Partial<NonNullable<InterceptorConfig['auth']>> = {}): InterceptorConfig {
  return {
    auth: {
      type: 'session-cookie',
      session_cookie_config: {
        login_endpoint: '/rest/login',
        username_field: 'email',
        username_from_env: 'LOGIN_USER',
        password_field: 'password',
        password_from_env: 'LOGIN_PASSWORD',
        cookie_names: ['sid'],
        ...(((overrides as Record<string, unknown>).session_cookie_config || {}) as Record<string, unknown>),
      },
      ...(overrides as Record<string, unknown>),
    } as InterceptorConfig['auth'],
  };
}

describe('session-cookie auth runtime', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      LOGIN_USER: 'user@example.com',
      LOGIN_PASSWORD: 'secret-password',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    delete (global as Record<string, unknown>).fetch;
    vi.useRealTimers();
  });

  it('parses combined set-cookie headers with expires attributes', () => {
    const cookies = SetCookieParser.parseHeader(
      'sid=abc; Path=/; Expires=Mon, 09 Mar 2026 14:37:04 GMT, theme=light; Path=/'
    );

    expect(cookies).toHaveLength(2);
    expect(cookies[0].name).toBe('sid');
    expect(cookies[1]).toMatchObject({ name: 'theme', value: 'light' });
  });

  it('stores only allowed cookies and prunes expired values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-02T00:00:00.000Z'));

    const jar = new SessionCookieJar(new Set(['sid']));
    expect(jar.upsertFromHeader('theme=light; Path=/, sid=abc; Path=/; Max-Age=60')).toBe(true);
    expect(jar.getAuthCredentials(0)).toEqual({
      headers: {
        Cookie: 'sid=abc',
      },
    });

    expect(jar.upsertFromHeader('sid=expired; Path=/; Max-Age=0')).toBe(true);
    expect(jar.getAuthCredentials(0)).toEqual({ headers: {} });
  });

  it('deduplicates concurrent login attempts and enforces failure backoff', async () => {
    const coordinator = new SessionCookieCoordinator(10_000);
    let resolver: (() => void) | undefined;
    let runs = 0;

    const task = coordinator.run(async () => {
      runs += 1;
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
    });
    const sameTask = coordinator.run(async () => {
      runs += 1;
    });

    expect(runs).toBe(1);
    resolver?.();
    await Promise.all([task, sameTask]);
    expect(runs).toBe(1);

    await expect(coordinator.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(coordinator.run(async () => {})).rejects.toBeInstanceOf(SessionCookieBackoffError);
  });

  it('logs in lazily and returns a maintained cookie header', async () => {
    global.fetch = vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'Set-Cookie': 'sid=login-cookie; Path=/; HttpOnly',
      },
    }));

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
    );

    const credentials = await manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    });

    expect(credentials).toEqual({
      headers: {
        Cookie: 'sid=login-cookie',
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/rest/login',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('fails when login succeeds without a matching session cookie', async () => {
    global.fetch = vi.fn(async () => new Response('', {
      status: 200,
      headers: {},
    }));

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).rejects.toBeInstanceOf(SessionCookieMissingError);
  });

  it('rejects login endpoints on disallowed absolute hosts', async () => {
    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig({
        session_cookie_config: {
          login_endpoint: 'https://evil.example.com/login',
        },
      }).auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('reauthenticates once on auth failure, replays the request, and rotates cookies from responses', async () => {
    const config = createSessionCookieConfig();
    const manager = new SessionCookieAuthManager(
      config.auth!.session_cookie_config!,
      'https://api.example.com',
    );
    const client = new HttpClient(
      'https://api.example.com',
      new InterceptorChain(config, manager),
      null,
      undefined,
      mockSSRFValidator,
    );

    const callUrls: string[] = [];
    const callHeaders: Array<Record<string, string>> = [];
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      callUrls.push(url.toString());
      callHeaders.push((init?.headers as Record<string, string>) || {});

      if (callUrls.length === 1) {
        return new Response('', {
          status: 200,
          headers: {
            'Set-Cookie': 'sid=initial-cookie; Path=/; HttpOnly',
          },
        });
      }

      if (callUrls.length === 2) {
        return new Response(JSON.stringify({ error: 'expired' }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }

      if (callUrls.length === 3) {
        return new Response('', {
          status: 200,
          headers: {
            'Set-Cookie': 'sid=refresh-cookie; Path=/; HttpOnly',
          },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'sid=final-cookie; Path=/; HttpOnly',
        },
      });
    });

    const response = await client.request('GET', '/items');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(callUrls).toEqual([
      'https://api.example.com/rest/login',
      'https://api.example.com/items',
      'https://api.example.com/rest/login',
      'https://api.example.com/items',
    ]);
    expect(callHeaders[1].Cookie).toBe('sid=initial-cookie');
    expect(callHeaders[3].Cookie).toBe('sid=refresh-cookie');
    expect(client.getAuthCredentials()).toEqual({
      headers: {
        Cookie: 'sid=final-cookie',
      },
    });
  });
});
