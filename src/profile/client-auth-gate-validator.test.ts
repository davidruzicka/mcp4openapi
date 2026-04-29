import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateClientAuthGateProfile } from './client-auth-gate-validator.js';
import { ClientAuthGateError } from '../core/errors.js';
import type { Profile } from '../types/profile.js';

function createProfile(overrides?: Partial<Profile>): Profile {
  return {
    profile_name: 'client-auth-gate-test',
    tools: [],
    ...overrides,
  } as Profile;
}

describe('validateClientAuthGateProfile', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const trackedEnvKeys = [
    'TEST_API_KEY_A',
    'TEST_API_KEY_B',
    'TEST_GATE_MODE',
    'NOT_SET_ENV_VAR',
  ];

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    for (const key of trackedEnvKeys) {
      delete process.env[key];
    }
  });

  it('returns undefined when client_auth_gate is not configured', () => {
    expect(validateClientAuthGateProfile(createProfile())).toBeUndefined();
  });

  it('accepts a valid inline api_keys configuration', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    process.env.TEST_API_KEY_B = 'secret-b';
    const profile = createProfile({
      client_auth_gate: {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [
            { key_from_env: 'TEST_API_KEY_A', subject: 'service-a', scopes: ['read'] },
            { key_from_env: 'TEST_API_KEY_B', subject: 'service-b' },
          ],
        },
      },
    });

    const result = validateClientAuthGateProfile(profile);
    expect(result).toBeDefined();
    expect(result?.mode).toBe('required');
    expect(result?.api_keys?.type).toBe('inline');
    if (result?.api_keys?.type === 'inline') {
      expect(result.api_keys.keys).toHaveLength(2);
      expect(result.api_keys.keys[0]?.subject).toBe('service-a');
    }
  });

  it("defaults mode to 'required' when neither mode nor mode_from_env is set", () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    const profile = createProfile({
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    const result = validateClientAuthGateProfile(profile);
    expect(result?.mode).toBe('required');
  });

  it("resolves mode from mode_from_env when present", () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    process.env.TEST_GATE_MODE = 'optional';
    const profile = createProfile({
      client_auth_gate: {
        mode_from_env: 'TEST_GATE_MODE',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(validateClientAuthGateProfile(profile)?.mode).toBe('optional');
  });

  it('rejects when mode_from_env env var is unset', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    const profile = createProfile({
      client_auth_gate: {
        mode_from_env: 'NOT_SET_ENV_VAR',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(ClientAuthGateError);
    expect(() => validateClientAuthGateProfile(profile)).toThrow(/NOT_SET_ENV_VAR/);
  });

  it("rejects mode with invalid value resolved from env", () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    process.env.TEST_GATE_MODE = 'admin';
    const profile = createProfile({
      client_auth_gate: {
        mode_from_env: 'TEST_GATE_MODE',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/must be 'required' or 'optional'/);
  });

  it('returns config when mode=optional and no api_keys configured', () => {
    const profile = createProfile({ client_auth_gate: { mode: 'optional' } });
    const result = validateClientAuthGateProfile(profile);
    expect(result).toEqual({ mode: 'optional', api_keys: undefined });
  });

  it('resolves mode=required from mode_from_env', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    process.env.TEST_GATE_MODE = 'required';
    const profile = createProfile({
      client_auth_gate: {
        mode_from_env: 'TEST_GATE_MODE',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });
    expect(validateClientAuthGateProfile(profile)?.mode).toBe('required');
  });

  it("rejects api_keys.type='sasanka' (Phase 4 only)", () => {
    const profile = createProfile({
      client_auth_gate: {
        api_keys: { type: 'sasanka' as never } as never,
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(ClientAuthGateError);
    expect(() => validateClientAuthGateProfile(profile)).toThrow(/sasanka.*not supported/);
  });

  it("rejects api_keys.type='vault' (unknown backend)", () => {
    const profile = createProfile({
      client_auth_gate: {
        api_keys: { type: 'vault' as never } as never,
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(ClientAuthGateError);
    expect(() => validateClientAuthGateProfile(profile)).toThrow(/vault.*not supported/);
  });

  it('rejects inline api_keys with empty keys array', () => {
    const profile = createProfile({
      client_auth_gate: {
        api_keys: { type: 'inline', keys: [] },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/non-empty array/);
  });

  it('rejects inline api_keys entry with empty key_from_env', () => {
    const profile = createProfile({
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: '   ', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/key_from_env is required/);
  });

  it('rejects inline api_keys entry with empty subject', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    const profile = createProfile({
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: '' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/subject is required/);
  });

  it('rejects inline api_keys entry whose key_from_env env var is not set (fail-fast)', () => {
    const profile = createProfile({
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'NOT_SET_ENV_VAR', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(ClientAuthGateError);
    expect(() => validateClientAuthGateProfile(profile)).toThrow(/NOT_SET_ENV_VAR.*not set/);
  });

  it('rejects when mode=required and api_keys is missing (jwt added in Phase 4)', () => {
    const profile = createProfile({
      client_auth_gate: { mode: 'required' },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/api_keys must be configured/);
  });

  it('rejects when mode_from_env resolves to invalid value', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    process.env.TEST_GATE_MODE = 'banana';
    const profile = createProfile({
      client_auth_gate: {
        mode_from_env: 'TEST_GATE_MODE',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/must be 'required' or 'optional'/);
  });

  it('rejects when client_auth_gate is combined with OAuth interceptor (single object)', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    const profile = createProfile({
      interceptors: {
        auth: {
          type: 'oauth',
          oauth_config: {
            authorization_endpoint: 'https://issuer.example/oauth/authorize',
            token_endpoint: 'https://issuer.example/oauth/token',
          },
        },
      },
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/cannot be combined with OAuth/);
  });

  it('rejects when client_auth_gate is combined with OAuth interceptor (in array)', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    const profile = createProfile({
      interceptors: {
        auth: [
          { type: 'bearer', value_from_env: 'SOME_TOKEN' },
          {
            type: 'oauth',
            oauth_config: {
              authorization_endpoint: 'https://issuer.example/oauth/authorize',
              token_endpoint: 'https://issuer.example/oauth/token',
            },
          },
        ],
      },
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(/cannot be combined with OAuth/);
  });

  it('allows client_auth_gate alongside non-OAuth interceptors (e.g. bearer)', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    const profile = createProfile({
      interceptors: {
        auth: { type: 'bearer', value_from_env: 'SOME_TOKEN' },
      },
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).not.toThrow();
  });

  it('rejects when client_auth_gate is combined with bearer interceptor that has validation_endpoint', () => {
    process.env.TEST_API_KEY_A = 'secret-a';
    const profile = createProfile({
      interceptors: {
        auth: {
          type: 'bearer',
          value_from_env: 'SOME_TOKEN',
          validation_endpoint: 'https://auth.internal/validate',
        },
      },
      client_auth_gate: {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: 'TEST_API_KEY_A', subject: 'svc' }],
        },
      },
    });

    expect(() => validateClientAuthGateProfile(profile)).toThrow(ClientAuthGateError);
    expect(() => validateClientAuthGateProfile(profile)).toThrow(/validation_endpoint/);
  });
});
