import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveConsentGateConfig,
  validateConsentGateProfile,
} from './consent-gate-validator.js';
import { ConsentGateConfigurationError } from '../core/errors.js';
import type { Profile } from '../types/profile.js';

function createProfile(overrides?: Partial<Profile>): Profile {
  return {
    profile_name: 'consent-gate-test',
    tools: [],
    ...overrides,
  } as Profile;
}

describe('resolveConsentGateConfig', () => {
  it('accepts a valid required config bound to profile OAuth', () => {
    const result = resolveConsentGateConfig({
      required: true,
      rules_version: 'v1',
      identity_source: 'profile_oauth',
    });
    expect(result.required).toBe(true);
    expect(result.rules_version).toBe('v1');
    expect(result.identity_source).toBe('profile_oauth');
  });

  it('accepts required=false with profile OAuth identity source', () => {
    const result = resolveConsentGateConfig({ required: false, rules_version: 'v1', identity_source: 'profile_oauth' });
    expect(result.required).toBe(false);
  });

  it('rejects an empty rules_version', () => {
    expect(() =>
      resolveConsentGateConfig({ required: false, rules_version: '   ', identity_source: 'profile_oauth' }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects an unsupported identity source', () => {
    expect(() =>
      resolveConsentGateConfig({ required: true, rules_version: 'v1', identity_source: 'other' as 'profile_oauth' }),
    ).toThrow(ConsentGateConfigurationError);
  });
});

describe('validateConsentGateProfile', () => {
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
  });

  it('returns undefined when consent_gate is not configured', () => {
    expect(validateConsentGateProfile(createProfile())).toBeUndefined();
  });

  it('returns the resolved config when consent_gate is valid', () => {
    const config = validateConsentGateProfile(
      createProfile({
        consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
        interceptors: {
          auth: {
            type: 'oauth',
            oauth_config: {
              issuer: 'https://login.example.test',
              client_id: 'client',
              redirect_uri: 'https://gateway.example.test/oauth/callback',
              scopes: ['openid'],
            },
          },
        },
      }),
    );
    expect(config?.required).toBe(true);
    expect(config?.rules_version).toBe('v1');
  });

  it('rejects a required gate without profile OAuth', () => {
    expect(() =>
      validateConsentGateProfile(
        createProfile({ consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' } }),
      ),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects profile OAuth without openid scope', () => {
    expect(() => validateConsentGateProfile(createProfile({
      consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
      interceptors: { auth: { type: 'oauth', oauth_config: { issuer: 'https://login.example.test', scopes: ['Files.Read'] } } },
    }))).toThrow(ConsentGateConfigurationError);
  });
});
