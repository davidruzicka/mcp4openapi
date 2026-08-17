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

  it('accepts max_age_days=1 as the smallest valid expiry window', () => {
    const result = resolveConsentGateConfig({
      required: true,
      rules_version: 'v1',
      identity_source: 'profile_oauth',
      max_age_days: 1,
    });
    expect(result.max_age_days).toBe(1);
  });

  it.each([0, -5, 1.5])('rejects max_age_days=%s', (maxAgeDays) => {
    // 0 would silently disable expiry under the old truthiness check and a
    // negative value would mark every grant expired; both invert admin intent.
    expect(() =>
      resolveConsentGateConfig({
        required: true,
        rules_version: 'v1',
        identity_source: 'profile_oauth',
        max_age_days: maxAgeDays,
      }),
    ).toThrow('consent_gate.max_age_days must be a positive integer number of days');
  });

  it('accepts labels and a template carrying the consent body placeholder', () => {
    const result = resolveConsentGateConfig({
      required: true,
      rules_version: 'v1',
      identity_source: 'profile_oauth',
      labels: { accept: 'Souhlasím ({{rules_version}})', submit: 'Potvrdit' },
      template: '<html><body>{{consent_body}}</body></html>',
    });
    expect(result.labels?.accept).toBe('Souhlasím ({{rules_version}})');
    expect(result.template).toContain('{{consent_body}}');
  });

  it.each(['accept', 'submit'] as const)('rejects a blank labels.%s', (key) => {
    expect(() =>
      resolveConsentGateConfig({
        required: true,
        rules_version: 'v1',
        identity_source: 'profile_oauth',
        labels: { [key]: '   ' },
      }),
    ).toThrow(`consent_gate.labels.${key} must be a non-empty string when set`);
  });

  it('rejects a blank template_path', () => {
    expect(() =>
      resolveConsentGateConfig({
        required: true,
        rules_version: 'v1',
        identity_source: 'profile_oauth',
        template_path: '   ',
      }),
    ).toThrow('consent_gate.template_path must be a non-empty string when set');
  });

  it('rejects a template without the consent body placeholder', () => {
    // A template with no placeholder would render a consent page that offers
    // no way to consent.
    expect(() =>
      resolveConsentGateConfig({
        required: true,
        rules_version: 'v1',
        identity_source: 'profile_oauth',
        template: '<html><body>pretty but useless</body></html>',
      }),
    ).toThrow('consent_gate.template must contain the {{consent_body}} placeholder');
  });
});

describe('validateConsentGateProfile', () => {
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

describe('consent gate validation failure paths', () => {
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

  it('rejects a non-boolean required flag', () => {
    expect(() =>
      resolveConsentGateConfig({
        required: 'yes',
        rules_version: 'v1',
        identity_source: 'profile_oauth',
      } as never),
    ).toThrow('consent_gate.required must be a boolean');
  });

  it('rejects a missing required flag', () => {
    expect(() =>
      resolveConsentGateConfig({ rules_version: 'v1', identity_source: 'profile_oauth' } as never),
    ).toThrow('consent_gate.required must be a boolean');
  });

  it('returns a non-required gate without demanding OAuth or an upstream', () => {
    // required=false is the short-circuit branch: a profile may declare the block
    // while the gate is switched off, with no OAuth interceptor and local tools.
    const profile = createProfile({
      consent_gate: { required: false, rules_version: 'v1', identity_source: 'profile_oauth' },
      tools: [
        { name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} },
      ],
    } as Partial<Profile>);

    expect(validateConsentGateProfile(profile)).toEqual({
      required: false,
      rules_version: 'v1',
      identity_source: 'profile_oauth',
      education_resource: undefined,
      rules_summary: undefined,
    });
  });

  it.each(['issuer', 'client_id', 'redirect_uri'] as const)(
    'rejects a required gate whose profile OAuth omits %s',
    (field) => {
      const oauthConfig = { ...profileOAuth.auth.oauth_config, [field]: '   ' };
      const profile = createProfile({
        consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
        interceptors: { auth: { ...profileOAuth.auth, oauth_config: oauthConfig } },
        upstream_mcp: {
          name: 'upstream',
          transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
        },
      } as Partial<Profile>);

      expect(() => validateConsentGateProfile(profile)).toThrow(
        `profile OAuth ${field} is required when consent_gate is enabled`,
      );
    },
  );

  it('rejects a required gate whose profile OAuth drops a field entirely', () => {
    const oauthConfig = { ...profileOAuth.auth.oauth_config } as Record<string, unknown>;
    delete oauthConfig.client_id;
    const profile = createProfile({
      consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
      interceptors: { auth: { ...profileOAuth.auth, oauth_config: oauthConfig } },
      upstream_mcp: {
        name: 'upstream',
        transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
      },
    } as Partial<Profile>);

    expect(() => validateConsentGateProfile(profile)).toThrow(
      'profile OAuth client_id is required when consent_gate is enabled',
    );
  });
});

describe('consent gate OAuth env references', () => {
  const ENV_KEYS = [
    'CONSENT_TEST_ISSUER',
    'CONSENT_TEST_CLIENT_ID',
    'CONSENT_TEST_REDIRECT_URI',
    'CONSENT_TEST_CLIENT_SECRET',
  ] as const;

  const envRefProfile = (): Profile =>
    createProfile({
      consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
      interceptors: {
        auth: {
          type: 'oauth',
          oauth_config: {
            issuer: '${env:CONSENT_TEST_ISSUER}',
            client_id: '${env:CONSENT_TEST_CLIENT_ID}',
            client_secret: '${env:CONSENT_TEST_CLIENT_SECRET}',
            redirect_uri: '${env:CONSENT_TEST_REDIRECT_URI}',
            scopes: ['openid'],
          },
        },
      },
      upstream_mcp: {
        name: 'upstream',
        transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
      },
    });

  beforeEach(() => {
    process.env.CONSENT_TEST_ISSUER = 'https://login.example.test';
    process.env.CONSENT_TEST_CLIENT_ID = 'client';
    process.env.CONSENT_TEST_REDIRECT_URI = 'https://gateway.example.test/oauth/callback';
    process.env.CONSENT_TEST_CLIENT_SECRET = 'secret';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('accepts a required gate whose OAuth fields resolve from set env vars', () => {
    expect(validateConsentGateProfile(envRefProfile())?.required).toBe(true);
  });

  it.each([
    ['issuer', 'CONSENT_TEST_ISSUER'],
    ['client_id', 'CONSENT_TEST_CLIENT_ID'],
    ['redirect_uri', 'CONSENT_TEST_REDIRECT_URI'],
    ['client_secret', 'CONSENT_TEST_CLIENT_SECRET'],
  ] as const)('rejects a required gate when the %s env reference is unset', (field, envVar) => {
    delete process.env[envVar];
    expect(() => validateConsentGateProfile(envRefProfile())).toThrow(ConsentGateConfigurationError);
    expect(() => validateConsentGateProfile(envRefProfile())).toThrow(
      `profile OAuth ${field} references env var '${envVar}' which is not set`,
    );
  });
});

describe('consent gate vs tenant OAuth overrides', () => {
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

  const consentProfile = (): Profile =>
    createProfile({
      profile_id: 'consent-profile',
      consent_gate: { required: true, rules_version: 'v1', identity_source: 'profile_oauth' },
      interceptors: profileOAuth,
      upstream_mcp: {
        name: 'upstream',
        transport: { type: 'http-streamable', url: 'https://upstream.example.test/mcp' },
      },
    });

  const tenantsJson = (tenant: Record<string, unknown>): string =>
    JSON.stringify({ version: 1, tenants: [tenant] });

  afterEach(() => {
    delete process.env.MCP4_HTTP_TENANTS_JSON;
    delete process.env.MCP4_HTTP_TENANTS_FILE;
  });

  it('rejects a required gate when a matching tenant overrides OAuth', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = tenantsJson({
      tenant_id: 'tenant-a',
      profile_ids: ['consent-profile'],
      api_base_url: 'https://tenant-a.example.test',
      auth_mode: 'oauth',
      auth: {
        type: 'oauth',
        oauth_config: { issuer: 'https://other-idp.example.test', client_id: 'tenant-client' },
      },
    });

    expect(() => validateConsentGateProfile(consentProfile())).toThrow(ConsentGateConfigurationError);
    expect(() => validateConsentGateProfile(consentProfile())).toThrow(
      "incompatible with a tenant OAuth override (tenant 'tenant-a')",
    );
  });

  it('accepts a required gate when the matching tenant uses token auth', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = tenantsJson({
      tenant_id: 'tenant-a',
      profile_ids: ['consent-profile'],
      api_base_url: 'https://tenant-a.example.test',
      auth_mode: 'token',
      auth: { type: 'bearer', value_from_env: 'TENANT_TOKEN' },
    });

    expect(validateConsentGateProfile(consentProfile())?.required).toBe(true);
  });

  it('accepts a required gate when the OAuth-overriding tenant targets another profile', () => {
    process.env.MCP4_HTTP_TENANTS_JSON = tenantsJson({
      tenant_id: 'tenant-b',
      profile_ids: ['some-other-profile'],
      api_base_url: 'https://tenant-b.example.test',
      auth_mode: 'oauth',
      auth: {
        type: 'oauth',
        oauth_config: { issuer: 'https://other-idp.example.test', client_id: 'tenant-client' },
      },
    });

    expect(validateConsentGateProfile(consentProfile())?.required).toBe(true);
  });

  it('accepts a required gate when the matching oauth-mode tenant inherits profile OAuth', () => {
    // No tenant-level auth override: the tenant reuses the profile OAuth
    // provider, so the consent identity verifier still applies.
    process.env.MCP4_HTTP_TENANTS_JSON = tenantsJson({
      tenant_id: 'tenant-c',
      profile_ids: ['consent-profile'],
      api_base_url: 'https://tenant-c.example.test',
      auth_mode: 'oauth',
    });

    expect(validateConsentGateProfile(consentProfile())?.required).toBe(true);
  });
});
