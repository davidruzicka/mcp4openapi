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

describe('ProfileLoader session-cookie auth validation', () => {
  it('accepts a valid session-cookie auth config', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      {
        type: 'session-cookie',
        session_cookie_config: {
          login_endpoint: '/rest/login',
          username_field: 'email',
          username_from_env: 'LOGIN_USER',
          password_field: 'password',
          password_from_env: 'LOGIN_PASSWORD',
          cookie_names: ['sid'],
        },
      },
      {
        base_url: {
          value_from_env: 'API_BASE_URL',
          default: 'https://api.example.com',
        },
      },
    );

    const profile = await loader.load(profilePath);
    expect(profile.interceptors?.auth).toBeDefined();
  });

  it('rejects session-cookie auth without cookie names', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      {
        type: 'session-cookie',
        session_cookie_config: {
          login_endpoint: '/rest/login',
          username_field: 'email',
          username_from_env: 'LOGIN_USER',
          password_field: 'password',
          password_from_env: 'LOGIN_PASSWORD',
          cookie_names: [],
        },
      },
      {
        base_url: {
          value_from_env: 'API_BASE_URL',
          default: 'https://api.example.com',
        },
      },
    );

    await expect(loader.load(profilePath)).rejects.toThrow('cookie_names must contain at least one cookie name');
  });

  it('rejects unsafe login header names', async () => {
    const loader = new ProfileLoader();
    const profilePath = await writeProfile(
      {
        type: 'session-cookie',
        session_cookie_config: {
          login_endpoint: '/rest/login',
          username_field: 'email',
          username_from_env: 'LOGIN_USER',
          password_field: 'password',
          password_from_env: 'LOGIN_PASSWORD',
          cookie_names: ['sid'],
          login_static_headers: {
            constructor: 'oops',
          },
        },
      },
      {
        base_url: {
          value_from_env: 'API_BASE_URL',
          default: 'https://api.example.com',
        },
      },
    );

    await expect(loader.load(profilePath)).rejects.toThrow('contains invalid header name');
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
});
