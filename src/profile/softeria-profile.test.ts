import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileLoader } from './profile-loader.js';
import { isToolAllowedByProviderPolicy } from '../upstream/upstream-tool-sanitizer.js';

const FIXTURE_DIR = path.join(process.cwd(), 'tests/profiles/softeria-sharepoint');
const PROFILE_PATH = path.join(FIXTURE_DIR, 'profile.json');
const CAPTURE_SCRIPT = 'scripts/capture-softeria-catalog.sh';

interface UpstreamCatalogFixture {
  upstream_package: string;
  upstream_version: string;
  captured_at: string;
  capture_command: string;
  tool_count: number;
  tools: string[];
}

/**
 * The fixture's `upstream_version` is the single source of truth for the pin.
 * Discover the catalog file instead of hardcoding its name so a re-pin that
 * renames the fixture cannot leave a stale path behind.
 */
function readUpstreamCatalog(): { fileName: string; catalog: UpstreamCatalogFixture } {
  const fileNames = fs
    .readdirSync(FIXTURE_DIR)
    .filter((name) => /^upstream-catalog-.+\.fixture\.json$/.test(name));
  expect(fileNames, `expected exactly one upstream catalog fixture in ${FIXTURE_DIR}; regenerate with ${CAPTURE_SCRIPT}`).toHaveLength(1);
  const fileName = fileNames[0];
  const catalog = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, fileName), 'utf-8'),
  ) as UpstreamCatalogFixture;
  return { fileName, catalog };
}

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
      path.join(process.cwd(), 'tests/profiles/softeria-sharepoint/profile.json'),
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
      path.join(process.cwd(), 'tests/profiles/softeria-sharepoint/profile.json'),
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
      path.join(process.cwd(), 'tests/profiles/softeria-sharepoint/profile.json'),
    )).rejects.toThrow('upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy');
  });

  it('rejects a deployment policy that removes the static read-only boundary', async () => {
    process.env.SOFTERIA_UPSTREAM_MCP = JSON.stringify({
      name: 'softeria',
      transport: { type: 'http-streamable', url: 'https://softeria.prod.example/mcp' },
      auth: { type: 'bearer' },
    });

    await expect(new ProfileLoader().load(
      path.join(process.cwd(), 'tests/profiles/softeria-sharepoint/profile.json'),
    )).rejects.toThrow('upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy');
  });

  it('does not allow mutating-looking names that merely contain SharePoint keywords', async () => {
    const profile = await new ProfileLoader().load(
      path.join(process.cwd(), 'tests/profiles/softeria-sharepoint/profile.json'),
    );
    const policy = profile.upstream_mcp?.tools;

    expect(isToolAllowedByProviderPolicy('get-sharepoint-site', policy)).toBe(true);
    expect(isToolAllowedByProviderPolicy('create-sharepoint-list', policy)).toBe(false);
    expect(isToolAllowedByProviderPolicy('update-sharepoint-list-item', policy)).toBe(false);
    expect(isToolAllowedByProviderPolicy('delete-onedrive-file', policy)).toBe(false);
    expect(isToolAllowedByProviderPolicy('upload-file-content', policy)).toBe(false);
  });

  it('pins one upstream version consistently across profile, fixture name, and catalog metadata', () => {
    const { fileName, catalog } = readUpstreamCatalog();
    const version = catalog.upstream_version;
    const drift = `version drift detected; re-pin all sites together with ${CAPTURE_SCRIPT}`;

    expect(catalog.upstream_package, drift).toBe('@softeria/ms-365-mcp-server');
    expect(fileName, drift).toBe(`upstream-catalog-${version}.fixture.json`);
    expect(catalog.capture_command, drift).toContain(`${catalog.upstream_package}@${version}`);

    const rawProfile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8')) as {
      upstream_pin?: { package: string; version: string };
    };
    expect(rawProfile.upstream_pin?.package, drift).toBe(catalog.upstream_package);
    expect(rawProfile.upstream_pin?.version, drift).toBe(version);
  });

  it('allows only tools that exist in the captured upstream catalog', async () => {
    const { catalog } = readUpstreamCatalog();
    const stale = `catalog does not match its own metadata; recapture with ${CAPTURE_SCRIPT}`;
    expect(catalog.tools, stale).toHaveLength(catalog.tool_count);

    const profile = await new ProfileLoader().load(PROFILE_PATH);
    const allow = profile.upstream_mcp?.tools?.allow ?? [];
    expect(allow.length).toBeGreaterThan(0);

    const upstreamTools = new Set(catalog.tools);
    expect(
      allow.filter(tool => !upstreamTools.has(tool)),
      `allow-list entries missing from the captured upstream catalog; recapture with ${CAPTURE_SCRIPT}`,
    ).toEqual([]);
  });

  it('excludes permission-mutating near-misses while keeping the read-only permission reader', async () => {
    const profile = await new ProfileLoader().load(PROFILE_PATH);
    const allow = profile.upstream_mcp?.tools?.allow ?? [];
    const policy = profile.upstream_mcp?.tools;

    expect(allow).toContain('list-drive-item-permissions');
    expect(isToolAllowedByProviderPolicy('list-drive-item-permissions', policy)).toBe(true);

    expect(allow).not.toContain('update-drive-item-permissions');
    expect(isToolAllowedByProviderPolicy('update-drive-item-permissions', policy)).toBe(false);

    const mutatingPermissionTools = allow.filter(tool =>
      /^(create|update|delete|set|add|remove|grant|revoke)-/.test(tool) && tool.includes('permission'),
    );
    expect(mutatingPermissionTools).toEqual([]);
  });

  it('keeps file downloads mediated by the gateway', async () => {
    const profile = await new ProfileLoader().load(PROFILE_PATH);
    const policy = profile.upstream_mcp?.tools;
    const allow = profile.upstream_mcp?.tools?.allow ?? [];

    // get-download-url returns a pre-authenticated Microsoft Graph URL that streams
    // bytes with no Authorization header, so content fetched with it never passes
    // the consent gate, the tool policy, or the audit trail. Downloads must use
    // download-bytes, which returns content through the gateway.
    expect(allow).not.toContain('get-download-url');
    expect(isToolAllowedByProviderPolicy('get-download-url', policy)).toBe(false);

    expect(allow).toContain('download-bytes');
    expect(isToolAllowedByProviderPolicy('download-bytes', policy)).toBe(true);
  });

  it('rejects an environment override that re-adds the unmediated download tool', () => {
    process.env.SOFTERIA_UPSTREAM_MCP = JSON.stringify({
      name: 'softeria',
      transport: { type: 'http-streamable', url: 'https://softeria.internal.example/mcp' },
      auth: { type: 'bearer' },
      tools: { allow: [...SOFTERIA_READ_ONLY_TOOLS, 'get-download-url'] },
    });

    return expect(new ProfileLoader().load(PROFILE_PATH)).rejects.toThrow(
      'upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy',
    );
  });
});
