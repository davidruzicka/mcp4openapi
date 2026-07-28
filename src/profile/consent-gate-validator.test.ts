import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveConsentGateConfig,
  validateConsentGateProfile,
} from './consent-gate-validator.js';
import { ConsentGateConfigurationError } from '../core/errors.js';
import type { ConsentOAuthConfig, Profile } from '../types/profile.js';

const SECRET_ENV = 'CONSENT_GATE_TEST_CLIENT_SECRET';

const validOAuth = (): ConsentOAuthConfig => ({
  authorization_endpoint: 'https://login.example.test/authorize',
  token_endpoint: 'https://login.example.test/token',
  client_id: 'consent-client',
  redirect_uri: 'https://mcp.example.test/consent/ms365/callback',
  scopes: ['openid'],
});

function createProfile(overrides?: Partial<Profile>): Profile {
  return {
    profile_name: 'consent-gate-test',
    tools: [],
    ...overrides,
  } as Profile;
}

describe('resolveConsentGateConfig', () => {
  afterEach(() => {
    delete process.env[SECRET_ENV];
  });

  it('accepts a valid required config with OAuth', () => {
    const result = resolveConsentGateConfig({
      required: true,
      rules_version: 'v1',
      oauth: validOAuth(),
    });
    expect(result.required).toBe(true);
    expect(result.rules_version).toBe('v1');
    expect(result.oauth?.client_id).toBe('consent-client');
  });

  it('accepts required=false without OAuth', () => {
    const result = resolveConsentGateConfig({ required: false, rules_version: 'v1' });
    expect(result.required).toBe(false);
    expect(result.oauth).toBeUndefined();
  });

  it('rejects an empty rules_version', () => {
    expect(() =>
      resolveConsentGateConfig({ required: false, rules_version: '   ' }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects required=true without an OAuth login', () => {
    expect(() =>
      resolveConsentGateConfig({ required: true, rules_version: 'v1' }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects an OAuth block missing a required field', () => {
    const oauth = validOAuth();
    oauth.token_endpoint = '';
    expect(() =>
      resolveConsentGateConfig({ required: true, rules_version: 'v1', oauth }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects a non-https authorization_endpoint', () => {
    const oauth = { ...validOAuth(), authorization_endpoint: 'http://login.example.test/authorize' };
    expect(() =>
      resolveConsentGateConfig({ required: true, rules_version: 'v1', oauth }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects a malformed token_endpoint', () => {
    const oauth = { ...validOAuth(), token_endpoint: 'not-a-url' };
    expect(() =>
      resolveConsentGateConfig({ required: true, rules_version: 'v1', oauth }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects a redirect_uri with a dangerous scheme', () => {
    const oauth = { ...validOAuth(), redirect_uri: 'javascript:alert(1)' };
    expect(() =>
      resolveConsentGateConfig({ required: true, rules_version: 'v1', oauth }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('accepts an http://localhost redirect_uri for local development', () => {
    const oauth = { ...validOAuth(), redirect_uri: 'http://localhost:3000/consent/callback' };
    const result = resolveConsentGateConfig({ required: true, rules_version: 'v1', oauth });
    expect(result.oauth?.redirect_uri).toBe('http://localhost:3000/consent/callback');
  });

  it('rejects when client_secret_from_env references an unset env var', () => {
    delete process.env[SECRET_ENV];
    const oauth = { ...validOAuth(), client_secret_from_env: SECRET_ENV };
    expect(() =>
      resolveConsentGateConfig({ required: true, rules_version: 'v1', oauth }),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('accepts when client_secret_from_env references a set env var', () => {
    process.env[SECRET_ENV] = 'shhh';
    const oauth = { ...validOAuth(), client_secret_from_env: SECRET_ENV };
    const result = resolveConsentGateConfig({
      required: true,
      rules_version: 'v1',
      oauth,
    });
    expect(result.oauth?.client_secret_from_env).toBe(SECRET_ENV);
  });
});

describe('validateConsentGateProfile', () => {
  const previousNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    delete process.env[SECRET_ENV];
  });

  it('returns undefined when consent_gate is not configured', () => {
    expect(validateConsentGateProfile(createProfile())).toBeUndefined();
  });

  it('returns the resolved config when consent_gate is valid', () => {
    const config = validateConsentGateProfile(
      createProfile({
        consent_gate: { required: true, rules_version: 'v1', oauth: validOAuth() },
      }),
    );
    expect(config?.required).toBe(true);
    expect(config?.rules_version).toBe('v1');
  });

  it('propagates configuration errors from an invalid consent_gate', () => {
    expect(() =>
      validateConsentGateProfile(
        createProfile({ consent_gate: { required: true, rules_version: 'v1' } }),
      ),
    ).toThrow(ConsentGateConfigurationError);
  });
});
