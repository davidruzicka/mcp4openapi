import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileLoader } from './profile-loader.js';
import { isToolAllowedByProviderPolicy } from '../upstream/upstream-tool-sanitizer.js';

const SOFTERIA_READ_ONLY_TOOLS = [
  'list-drives',
  'get-drive-delta',
  'get-drive-root-item',
  'list-folder-files',
  'get-drive-item',
  'list-drive-item-thumbnails',
  'list-drive-item-permissions',
  'list-drive-item-versions',
  'search-onedrive-files',
  'get-sharepoint-site',
  'list-sharepoint-site-drives',
  'get-sharepoint-site-drive-by-id',
  'list-sharepoint-site-items',
  'get-sharepoint-site-item',
  'list-sharepoint-site-lists',
  'get-sharepoint-site-list',
  'list-sharepoint-site-list-items',
  'get-sharepoint-site-list-item',
  'list-sharepoint-list-columns',
  'get-sharepoint-list-column',
  'get-sharepoint-site-by-path',
  'download-bytes',
  'get-download-url',
] as const;

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
    expect(profile.upstream_mcp?.tools?.allow).toEqual(SOFTERIA_READ_ONLY_TOOLS);
  });

  it('accepts a deployment-specific upstream endpoint with the same restrictive policy', async () => {
    process.env.SOFTERIA_UPSTREAM_MCP = JSON.stringify({
      name: 'softeria',
      transport: { type: 'http-streamable', url: 'https://softeria.prod.example/mcp' },
      auth: { type: 'bearer' },
      tools: { allow: [...SOFTERIA_READ_ONLY_TOOLS] },
    });

    const profile = await new ProfileLoader().load(
      path.join(process.cwd(), 'profiles/softeria-sharepoint/profile.json'),
    );
    expect(profile.upstream_mcp?.transport.url).toBe('https://softeria.prod.example/mcp');
    expect(profile.upstream_mcp?.tools?.allow).toEqual(SOFTERIA_READ_ONLY_TOOLS);
  });

  it('rejects a deployment policy that broadens the static read-only boundary', async () => {
    process.env.SOFTERIA_UPSTREAM_MCP = JSON.stringify({
      name: 'softeria',
      transport: { type: 'http-streamable', url: 'https://softeria.prod.example/mcp' },
      auth: { type: 'bearer' },
      tools: { allow: ['*site*'] },
    });

    await expect(new ProfileLoader().load(
      path.join(process.cwd(), 'profiles/softeria-sharepoint/profile.json'),
    )).rejects.toThrow('upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy');
  });

  it('rejects a deployment policy that removes the static read-only boundary', async () => {
    process.env.SOFTERIA_UPSTREAM_MCP = JSON.stringify({
      name: 'softeria',
      transport: { type: 'http-streamable', url: 'https://softeria.prod.example/mcp' },
      auth: { type: 'bearer' },
    });

    await expect(new ProfileLoader().load(
      path.join(process.cwd(), 'profiles/softeria-sharepoint/profile.json'),
    )).rejects.toThrow('upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy');
  });

  it('does not allow mutating-looking names that merely contain SharePoint keywords', async () => {
    const profile = await new ProfileLoader().load(
      path.join(process.cwd(), 'profiles/softeria-sharepoint/profile.json'),
    );
    const policy = profile.upstream_mcp?.tools;

    expect(isToolAllowedByProviderPolicy('get-sharepoint-site', policy)).toBe(true);
    expect(isToolAllowedByProviderPolicy('create-sharepoint-list', policy)).toBe(false);
    expect(isToolAllowedByProviderPolicy('update-sharepoint-list-item', policy)).toBe(false);
    expect(isToolAllowedByProviderPolicy('delete-onedrive-file', policy)).toBe(false);
    expect(isToolAllowedByProviderPolicy('upload-file-content', policy)).toBe(false);
  });
});
