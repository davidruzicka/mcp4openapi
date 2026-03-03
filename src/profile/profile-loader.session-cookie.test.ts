import fs from 'fs/promises';
import { describe, expect, it } from 'vitest';
import { ProfileLoader } from './profile-loader.js';

async function writeProfile(auth: Record<string, unknown>, interceptors: Record<string, unknown> = {}): Promise<string> {
  const filePath = `/tmp/profile-session-cookie-${Date.now()}-${Math.random()}.json`;
  await fs.writeFile(
    filePath,
    JSON.stringify({
      profile_name: 'session-cookie-profile',
      tools: [
        {
          name: 'list_items',
          description: 'List items',
          parameters: {},
          operations: {
            list: 'listItems',
          },
        },
      ],
      interceptors: {
        ...interceptors,
        auth,
      },
    }),
    'utf-8',
  );
  return filePath;
}

function createValidSessionCookieAuth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session-cookie',
    session_cookie_config: {
      login_endpoint: '/rest/login',
      username_field: 'email',
      username_from_env: 'LOGIN_USER',
      password_field: 'password',
      password_from_env: 'LOGIN_PASSWORD',
      cookie_names: ['sid'],
      ...overrides,
    },
  };
}

function createBaseUrlInterceptor(): Record<string, unknown> {
  return {
    base_url: {
      value_from_env: 'API_BASE_URL',
      default: 'https://api.example.com',
    },
  };
}

describe('ProfileLoader session-cookie auth validation', () => {
  it('accepts a valid session-cookie auth config', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      createValidSessionCookieAuth(),
      createBaseUrlInterceptor(),
    );

    const profile = await loader.load(profilePath);
    expect(profile.interceptors?.auth).toBeDefined();
  });

  it('rejects session-cookie auth without session_cookie_config', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      {
        type: 'session-cookie',
      },
      createBaseUrlInterceptor(),
    );

    await expect(loader.load(profilePath)).rejects.toThrow('session-cookie requires session_cookie_config');
  });

  it('rejects session-cookie auth without cookie names', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      createValidSessionCookieAuth({ cookie_names: [] }),
      createBaseUrlInterceptor(),
    );

    await expect(loader.load(profilePath)).rejects.toThrow('cookie_names must contain at least one cookie name');
  });

  it('rejects empty login endpoints and invalid absolute login URLs', async () => {
    const loader = new ProfileLoader();
    const emptyEndpointPath = await writeProfile(
      createValidSessionCookieAuth({ login_endpoint: '   ' }),
      createBaseUrlInterceptor(),
    );
    const invalidAbsolutePath = await writeProfile(
      createValidSessionCookieAuth({ login_endpoint: 'https://%' }),
      createBaseUrlInterceptor(),
    );

    await expect(loader.load(emptyEndpointPath)).rejects.toThrow('login_endpoint must not be empty');
    await expect(loader.load(invalidAbsolutePath)).rejects.toThrow('login_endpoint must be a valid absolute URL');
  });

  it('rejects empty cookie names and invalid numeric session-cookie settings', async () => {
    const loader = new ProfileLoader();
    const emptyCookieNamePath = await writeProfile(
      createValidSessionCookieAuth({ cookie_names: ['sid', ''] }),
      createBaseUrlInterceptor(),
    );
    const invalidBackoffPath = await writeProfile(
      createValidSessionCookieAuth({ failure_backoff_ms: 0 }),
      createBaseUrlInterceptor(),
    );
    const invalidSkewPath = await writeProfile(
      createValidSessionCookieAuth({ expiry_skew_ms: -1 }),
      createBaseUrlInterceptor(),
    );

    await expect(loader.load(emptyCookieNamePath)).rejects.toThrow('cookie_names must not contain empty values');
    await expect(loader.load(invalidBackoffPath)).rejects.toThrow('failure_backoff_ms must be greater than 0');
    await expect(loader.load(invalidSkewPath)).rejects.toThrow('expiry_skew_ms must be greater than or equal to 0');
  });

  it('rejects invalid reauth statuses and malformed login allowlists', async () => {
    const loader = new ProfileLoader();
    const emptyStatusesPath = await writeProfile(
      createValidSessionCookieAuth({ reauth_on_statuses: [] }),
      createBaseUrlInterceptor(),
    );
    const invalidStatusPath = await writeProfile(
      createValidSessionCookieAuth({ reauth_on_statuses: [200] }),
      createBaseUrlInterceptor(),
    );
    const invalidAllowHostPath = await writeProfile(
      createValidSessionCookieAuth({ login_allowed_hosts: ['*'] }),
      createBaseUrlInterceptor(),
    );

    await expect(loader.load(emptyStatusesPath)).rejects.toThrow('reauth_on_statuses must contain at least one status code');
    await expect(loader.load(invalidStatusPath)).rejects.toThrow('reauth_on_statuses must contain integer HTTP error statuses');
    await expect(loader.load(invalidAllowHostPath)).rejects.toThrow('login_allowed_hosts contains invalid host pattern');
  });

  it('rejects unsafe login header names', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      createValidSessionCookieAuth({
        login_static_headers: {
          constructor: 'oops',
        },
      }),
      createBaseUrlInterceptor(),
    );

    await expect(loader.load(profilePath)).rejects.toThrow('contains invalid header name');
  });

  it('rejects empty login header values', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      createValidSessionCookieAuth({
        login_static_headers: {
          'X-Test': '   ',
        },
      }),
      createBaseUrlInterceptor(),
    );

    await expect(loader.load(profilePath)).rejects.toThrow('login_static_headers must not contain empty header values');
  });

  it('rejects relative login endpoints when base_url is missing', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile({
      type: 'session-cookie',
      session_cookie_config: {
        login_endpoint: '/rest/login',
        username_field: 'email',
        username_from_env: 'LOGIN_USER',
        password_field: 'password',
        password_from_env: 'LOGIN_PASSWORD',
        cookie_names: ['sid'],
      },
    });

    await expect(loader.load(profilePath)).rejects.toThrow('login_endpoint must be absolute when interceptors.base_url is not configured');
  });

  it('rejects oauth auth configs without issuer or explicit endpoints', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile({
      type: 'oauth',
      oauth_config: {
        client_id: 'test-client',
      },
    });

    await expect(loader.load(profilePath)).rejects.toThrow(
      "must provide either 'issuer' OR both 'authorization_endpoint' and 'token_endpoint'"
    );
  });
});
