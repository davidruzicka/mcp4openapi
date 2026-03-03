import { afterEach, describe, expect, it } from 'vitest';
import type { Profile } from '../types/profile.js';
import { SessionCookieAuthManager } from './session-cookie-auth.js';
import { AuthStrategyRegistry } from './auth-strategies.js';

const originalEnv = { ...process.env };

function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    profile_name: 'test-profile',
    tools: [],
    ...overrides,
  };
}

describe('AuthStrategyRegistry', () => {
  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns token auth from env and prefers a session token override', () => {
    process.env.TEST_TOKEN = 'env-token';
    const registry = new AuthStrategyRegistry();
    const profile = createProfile({
      interceptors: {
        auth: {
          type: 'bearer',
          value_from_env: 'TEST_TOKEN',
        },
      },
    });

    const envResolved = registry.resolve({
      profile,
      baseUrl: 'https://api.example.com',
    });
    expect(envResolved.authToken).toBe('env-token');

    const sessionResolved = registry.resolve({
      profile,
      baseUrl: 'https://api.example.com',
      sessionToken: 'session-token',
    });
    expect(sessionResolved.authToken).toBe('session-token');
  });

  it('returns an empty resolution when no auth config is available', () => {
    const registry = new AuthStrategyRegistry();

    expect(registry.selectActiveAuthConfig()).toBeUndefined();
    expect(registry.resolve({
      profile: createProfile(),
      baseUrl: 'https://api.example.com',
    })).toEqual({});
  });

  it('returns the configured oauth auth entry when it is the only available option', () => {
    const registry = new AuthStrategyRegistry();
    const oauthConfig = {
      type: 'oauth',
      oauth_config: {
        issuer: 'https://issuer.example.com',
      },
    } as const;

    const selected = registry.selectActiveAuthConfig([oauthConfig]);
    const resolved = registry.resolve({
      profile: createProfile({ interceptors: { auth: [oauthConfig] } }),
      baseUrl: 'https://api.example.com',
    });

    expect(selected).toEqual(oauthConfig);
    expect(resolved.activeAuthConfig).toEqual(oauthConfig);
    expect(resolved.authRuntime).toBeUndefined();
  });

  it('sorts by priority, skips oauth when another auth type is available, and builds session-cookie runtime', () => {
    const registry = new AuthStrategyRegistry();
    const profile = createProfile({
      interceptors: {
        timeout_ms: 1234,
      },
    });

    const resolved = registry.resolve({
      profile,
      baseUrl: 'https://api.example.com',
      authConfigs: [
        {
          type: 'oauth',
          priority: 0,
          oauth_config: {
            issuer: 'https://issuer.example.com',
          },
        },
        {
          type: 'session-cookie',
          priority: 10,
          session_cookie_config: {
            login_endpoint: '/rest/login',
            username_field: 'email',
            username_from_env: 'LOGIN_USER',
            password_field: 'password',
            password_from_env: 'LOGIN_PASSWORD',
            cookie_names: ['sid'],
          },
        },
      ],
    });

    expect(resolved.activeAuthConfig?.type).toBe('session-cookie');
    expect(resolved.authRuntime).toBeInstanceOf(SessionCookieAuthManager);
  });
});
