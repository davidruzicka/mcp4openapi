import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileLoader } from './profile-loader.js';

const ENV = {
  SOFTERIA_ENTRA_ISSUER: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
  SOFTERIA_ENTRA_CLIENT_ID: 'client-id',
  SOFTERIA_ENTRA_CLIENT_SECRET: 'test-secret',
  SOFTERIA_OAUTH_REDIRECT_URI: 'https://gateway.example/profile/softeria-sharepoint/oauth/callback',
};

describe('Softeria SharePoint profile', () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
    delete process.env.SOFTERIA_UPSTREAM_MCP;
  });

  afterEach(() => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    delete process.env.SOFTERIA_UPSTREAM_MCP;
  });

  it('loads with strict OIDC consent and read-only SharePoint tool boundaries', async () => {
    const profile = await new ProfileLoader().load(
      path.join(process.cwd(), 'profiles/softeria-sharepoint/profile.json'),
    );
    const auth = Array.isArray(profile.interceptors?.auth)
      ? profile.interceptors.auth[0]
      : profile.interceptors?.auth;

    expect(profile.consent_gate).toMatchObject({
      required: true,
      identity_source: 'profile_oauth',
      rules_version: 'v1',
    });
    expect(auth?.oauth_config).toMatchObject({
      issuer: '${env:SOFTERIA_ENTRA_ISSUER}',
      client_id: '${env:SOFTERIA_ENTRA_CLIENT_ID}',
      client_secret: '${env:SOFTERIA_ENTRA_CLIENT_SECRET}',
      redirect_uri: '${env:SOFTERIA_OAUTH_REDIRECT_URI}',
      scopes: ['openid', 'Files.Read', 'Sites.Selected'],
    });
    expect(profile.upstream_mcp?.auth).toEqual({ type: 'bearer' });
    expect(profile.upstream_mcp?.tools?.allow).toEqual([
      '*sharepoint*',
      '*site*',
      '*drive*',
      'download-bytes',
      'get-download-url',
    ]);
  });

  it('accepts a deployment-specific upstream endpoint from env', async () => {
    process.env.SOFTERIA_UPSTREAM_MCP = JSON.stringify({
      name: 'softeria',
      transport: { type: 'http-streamable', url: 'https://softeria.prod.example/mcp' },
      auth: { type: 'bearer' },
      tools: { allow: ['*site*'] },
    });

    const profile = await new ProfileLoader().load(
      path.join(process.cwd(), 'profiles/softeria-sharepoint/profile.json'),
    );
    expect(profile.upstream_mcp?.transport.url).toBe('https://softeria.prod.example/mcp');
    expect(profile.upstream_mcp?.tools?.allow).toEqual(['*site*']);
  });
});
