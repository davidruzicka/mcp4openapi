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
  SessionCookieExpiredError,
  SessionCookieLoginError,
  SessionCookieBackoffError,
  SessionCookieMissingError,
} from '../core/errors.js';
import { SSRFValidator } from '../security/ssrf-validator.js';

const originalEnv = { ...process.env };


function createSessionCookieConfig(overrides: Partial<NonNullable<InterceptorConfig['auth']>> = {}): InterceptorConfig {
  const authOverrides = overrides as Record<string, unknown>;
  const sessionCookieOverrides = ((authOverrides.session_cookie_config || {}) as Record<string, unknown>);
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
        ...sessionCookieOverrides,
      },
      ...Object.fromEntries(
        Object.entries(authOverrides).filter(([key]) => key !== 'session_cookie_config')
      ),
    } as InterceptorConfig['auth'],
  };
}

describe('session-cookie auth runtime', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      LOGIN_USER: 'user@example.com',
      LOGIN_PASSWORD: 'secret-password',
      MCP4_SSRF_ALLOW_PRIVATE_NETWORK: 'true',
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

  it('ignores malformed cookies and preserves commas inside expires attributes', () => {
    const cookies = SetCookieParser.parseHeader(
      'invalid, sid=abc; Expires=Mon, 09 Mar 2026 14:37:04 GMT; Path=/, novalue=; Path=/'
    );

    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('sid');
    expect(SetCookieParser.parseHeader('; ;')).toEqual([]);
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

  it('returns false when cookie updates are missing or disallowed', async () => {
    const jar = new SessionCookieJar(new Set(['sid']));
    expect(jar.upsertFromHeader(undefined)).toBe(false);
    expect(jar.upsertFromHeader('theme=light; Path=/')).toBe(false);

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(manager.handleAuthFailure({
      status: 403,
      headers: {},
      body: { error: 'forbidden' },
    })).resolves.toBe(false);
    await expect(manager.onResponse({
      status: 200,
      headers: {},
      body: { ok: true },
    })).resolves.toBeUndefined();
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

  it('rejects login endpoints on same hostname with a different origin unless allowlisted', async () => {
    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig({
        session_cookie_config: {
          login_endpoint: 'http://api.example.com:8080/login',
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

  it('aborts login fetch when it exceeds the configured timeout', async () => {
    vi.useFakeTimers();

    global.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new Error('aborted'));
      }, { once: true });
    }));

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
      undefined,
      50,
    );

    const pendingRequest = manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    }).catch((caughtError) => caughtError);

    await vi.advanceTimersByTimeAsync(50);

    const error = await pendingRequest;

    expect(error).toBeInstanceOf(SessionCookieLoginError);
    expect(error).toMatchObject({
      details: {
        timeoutMs: 50,
      },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/rest/login',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('rethrows non-timeout login transport failures', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).rejects.toThrow('socket hang up');
  });

  it('throws a typed error when login returns a non-success response', async () => {
    global.fetch = vi.fn(async () => new Response('bad credentials', {
      status: 401,
      headers: {
        'Content-Type': 'text/plain',
      },
    }));

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).rejects.toMatchObject({
      name: 'SessionCookieLoginError',
      message: 'bad credentials',
      details: {
        statusCode: 401,
      },
    });
  });

  it('throws an expired error when login returns only immediately expired cookies', async () => {
    global.fetch = vi.fn(async () => new Response('', {
      status: 200,
      headers: {
        'Set-Cookie': 'sid=expired; Path=/; Max-Age=0',
      },
    }));

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).rejects.toBeInstanceOf(SessionCookieExpiredError);
  });

  it('supports x-www-form-urlencoded login payloads and forwards static body fields', async () => {
    global.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      expect((init?.body as URLSearchParams).toString()).toBe('realm=users&email=user%40example.com&password=secret-password');
      return new Response('', {
        status: 200,
        headers: {
          'Set-Cookie': 'sid=form-cookie; Path=/; HttpOnly',
        },
      });
    });

    const manager = new SessionCookieAuthManager(
      createSessionCookieConfig({
        session_cookie_config: {
          login_content_type: 'application/x-www-form-urlencoded',
          login_static_body: {
            realm: 'users',
          },
        },
      }).auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(manager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).resolves.toEqual({
      headers: {
        Cookie: 'sid=form-cookie',
      },
    });
  });

  it('rejects invalid login header names and missing session-cookie env vars', async () => {
    delete process.env.LOGIN_PASSWORD;

    const missingEnvManager = new SessionCookieAuthManager(
      createSessionCookieConfig().auth!.session_cookie_config!,
      'https://api.example.com',
    );
    await expect(missingEnvManager.prepareRequest({
      method: 'GET',
      url: 'https://api.example.com/items',
      headers: {},
    })).rejects.toBeInstanceOf(ConfigurationError);

    process.env.LOGIN_PASSWORD = 'secret-password';
    const invalidHeaderManager = new SessionCookieAuthManager(
      createSessionCookieConfig({
        session_cookie_config: {
          login_static_headers: {
            constructor: 'bad',
          },
        },
      }).auth!.session_cookie_config!,
      'https://api.example.com',
    );

    await expect(invalidHeaderManager.prepareRequest({
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
      new SSRFValidator({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any),
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
