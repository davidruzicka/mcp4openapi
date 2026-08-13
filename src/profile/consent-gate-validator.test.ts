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

  it('preserves the whole policy, including max_age_days, through resolution', () => {
    // The resolver rebuilds the config field by field and ProfileLoader writes the
    // result back onto the profile, so a dropped field silently disables policy.
    const result = resolveConsentGateConfig({
      required: true,
      rules_version: 'v1',
      rules_summary: 'Accept the rules.',
      education_resource: 'https://kb.example.test/rules',
      max_age_days: 30,
      identity_source: 'profile_oauth',
    });
    expect(result).toEqual({
      required: true,
      rules_version: 'v1',
      rules_summary: 'Accept the rules.',
      education_resource: 'https://kb.example.test/rules',
      max_age_days: 30,
      identity_source: 'profile_oauth',
    });
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
  const requiredConsentGate = { required: true, rules_version: 'v1', identity_source: 'profile_oauth' } as const;
  const profileOAuth = {
    auth: {
      type: 'oauth' as const,
      oauth_config: {
        issuer: 'https://login.example.test',
        client_id: 'client',
        redirect_uri: 'https://gateway.example.test/oauth/callback',
        scopes: ['openid'],
      },
    },
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
  });

  it('returns undefined when consent_gate is not configured', () => {
    expect(validateConsentGateProfile(createProfile())).toBeUndefined();
  });

  it('accepts a required gate with a static upstream MCP source', () => {
    const config = validateConsentGateProfile(
      createProfile({
        consent_gate: requiredConsentGate,
        interceptors: profileOAuth,
        upstream_mcp: {
          name: 'upstream',
          transport: {
            type: 'http-streamable',
            url: 'https://upstream.example.test/mcp',
          },
        },
      }),
    );
    expect(config?.required).toBe(true);
    expect(config?.rules_version).toBe('v1');
  });

  it('rejects a required gate with only an unresolved upstream MCP environment reference', () => {
    expect(() => validateConsentGateProfile(createProfile({
      consent_gate: requiredConsentGate,
      interceptors: profileOAuth,
      upstream_mcp_from_env: 'MCP4_UNRESOLVED_UPSTREAM_MCP_FOR_CONSENT_GATE_TEST',
    }))).toThrow('requires an effective upstream_mcp configuration');
  });

  it('rejects a required gate when upstream_mcp is absent entirely', () => {
    // Same guard as the unresolved-env-reference case, reached without any
    // upstream_mcp source configured at all.
    expect(() => validateConsentGateProfile(createProfile({
      consent_gate: requiredConsentGate,
      interceptors: profileOAuth,
      upstream_mcp: undefined,
    }))).toThrow(ConsentGateConfigurationError);
    expect(() => validateConsentGateProfile(createProfile({
      consent_gate: requiredConsentGate,
      interceptors: profileOAuth,
      upstream_mcp: undefined,
    }))).toThrow('consent_gate.required=true requires an effective upstream_mcp configuration');
  });

  it('rejects a required gate when local tools are configured', () => {
    expect(() => validateConsentGateProfile(createProfile({
      consent_gate: requiredConsentGate,
      interceptors: profileOAuth,
      upstream_mcp: {
        name: 'upstream',
        transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
      },
      tools: [{ name: 'local_tool' }] as Profile['tools'],
    }))).toThrow('supports upstream MCP tools only and cannot define local tools');
  });

  it('rejects a required gate without profile OAuth', () => {
    expect(() =>
      validateConsentGateProfile(
        createProfile({
          consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
          upstream_mcp: {
            name: 'upstream',
            transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
          },
        }),
      ),
    ).toThrow(ConsentGateConfigurationError);
  });

  it('rejects profile OAuth without openid scope', () => {
    expect(() => validateConsentGateProfile(createProfile({
      consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
      interceptors: { auth: { type: 'oauth', oauth_config: { issuer: 'https://login.example.test', scopes: ['Files.Read'] } } },
      upstream_mcp: {
        name: 'upstream',
        transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
      },
    }))).toThrow(ConsentGateConfigurationError);
  });
});
