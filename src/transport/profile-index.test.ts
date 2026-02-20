import { describe, it, expect } from 'vitest';
import {
  buildProfileIndexPayload,
  parseAcceptLanguage,
  renderProfileIndexHtml,
  loadProfileIndexTemplate,
  __test__,
  resolveTemplateRoot,
} from './profile-index.js';
import type { ListedProfileDetails } from '../profile/profile-resolver.js';
import type { ProfileIndexSourceProfile } from './profile-index.js';

describe('profile index helpers', () => {
  it('detects locale from Accept-Language', () => {
    expect(parseAcceptLanguage(undefined)).toBe('en');
    expect(parseAcceptLanguage('cs-CZ,cs;q=0.9,en;q=0.8')).toBe('cs');
    expect(parseAcceptLanguage('en-US,en;q=0.9')).toBe('en');
  });

  it('builds bearer snippets with correct formats', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'gitlab',
        profileName: 'gitlab',
        profileAliases: [],
        description: 'GitLab',
        envVars: ['GITLAB_API_BASE_URL', 'GITLAB_TOKEN'],
        authMethods: [
          {
            type: 'bearer',
            valueFromEnv: 'GITLAB_TOKEN',
          },
        ],
        apiBaseUrl: {
          valueFromEnv: 'GITLAB_API_BASE_URL',
          defaultValue: 'https://gitlab.com/api/v4',
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    const vscode = profile.snippets.find(s => s.key === 'vscode-bearer');
    const cursor = profile.snippets.find(s => s.key === 'cursor-bearer');
    const jetbrains = profile.snippets.find(s => s.key === 'jetbrains-bearer');
    const claudeJson = profile.snippets.find(s => s.key === 'claude-json-bearer');
    const claudeCli = profile.snippets.find(s => s.key === 'claude-cli-bearer');
    const vscodeLocal = profile.snippets.find(s => s.key === 'vscode-local-bearer');
    const cursorLocal = profile.snippets.find(s => s.key === 'cursor-local-bearer');
    const jetbrainsLocal = profile.snippets.find(s => s.key === 'jetbrains-local-bearer');
    const claudeLocalJson = profile.snippets.find(s => s.key === 'claude-local-json-bearer');
    const claudeLocalCli = profile.snippets.find(s => s.key === 'claude-local-cli-bearer');
    const geminiJson = profile.snippets.find(s => s.key === 'gemini-json-bearer');
    const geminiCli = profile.snippets.find(s => s.key === 'gemini-cli-bearer');
    const geminiLocalJson = profile.snippets.find(s => s.key === 'gemini-local-json-bearer');
    const geminiLocalCli = profile.snippets.find(s => s.key === 'gemini-local-cli-bearer');
    const codexToml = profile.snippets.find(s => s.key === 'codex-toml-bearer');
    const codexCli = profile.snippets.find(s => s.key === 'codex-cli-bearer');
    const codexLocalToml = profile.snippets.find(s => s.key === 'codex-local-toml-bearer');

    expect(profile.mcpUrl).toBe('http://localhost:3003/profile/gitlab/mcp');
    expect(profile.modeTabs).toEqual([
      { key: 'remote', label: 'Remote HTTP' },
      { key: 'local', label: 'Local stdio' },
    ]);
    expect(vscode?.content).toContain('"url": "__PROFILE_URL__"');
    expect(vscode?.content).toContain('"Authorization": "Bearer ${input:gitlab-token}"');
    expect(cursor?.content).toContain('"mcp-remote"');
    expect(cursor?.content).toContain('"Authorization: Bearer ${env:GITLAB_TOKEN}"');
    expect(cursor?.content).toContain('"GITLAB_TOKEN": "${env:GITLAB_TOKEN}"');
    expect(jetbrains?.content).toContain('"requestInit"');
    expect(jetbrains?.content).toContain('"Authorization": "Bearer {$input:gitlab-token}"');
    expect(claudeJson?.format).toBe('json');
    expect(claudeJson?.content).toContain('"mcpServers"');
    expect(claudeJson?.content).toContain('"type": "http"');
    expect(claudeJson?.content).toContain('"url": "__PROFILE_URL__"');
    expect(claudeJson?.content).toContain('"Authorization": "Bearer ${GITLAB_TOKEN}"');
    expect(claudeCli?.format).toBe('cli');
    expect(claudeCli?.content).toContain('claude mcp add -s user __PROFILE_ID__ --transport http __PROFILE_URL__');
    expect(claudeCli?.content).toContain('Authorization: Bearer \\${GITLAB_TOKEN}');
    expect(vscodeLocal?.mode).toBe('local');
    expect(vscodeLocal?.content).toContain('"type": "stdio"');
    expect(vscodeLocal?.content).toContain('"mcp4openapi"');
    expect(vscodeLocal?.content).toContain('"--profile"');
    expect(vscodeLocal?.content).toContain('"GITLAB_TOKEN": "${input:gitlab-token}"');
    expect(vscodeLocal?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
    expect(cursorLocal?.mode).toBe('local');
    expect(cursorLocal?.content).toContain('"GITLAB_TOKEN": "${env:GITLAB_TOKEN}"');
    expect(cursorLocal?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
    expect(cursorLocal?.content).not.toContain('${input:gitlab-token}');
    expect(jetbrainsLocal?.mode).toBe('local');
    expect(jetbrainsLocal?.content).toContain('"GITLAB_TOKEN": "{$input:gitlab-token}"');
    expect(claudeLocalJson?.mode).toBe('local');
    expect(claudeLocalJson?.format).toBe('json');
    expect(claudeLocalJson?.content).toContain('"mcpServers"');
    expect(claudeLocalJson?.content).toContain('"command": "npx"');
    expect(claudeLocalJson?.content).toContain('"GITLAB_TOKEN": "${GITLAB_TOKEN}"');
    expect(claudeLocalJson?.content).not.toContain('${env:GITLAB_TOKEN}');
    expect(claudeLocalCli?.mode).toBe('local');
    expect(claudeLocalCli?.format).toBe('cli');
    expect(claudeLocalCli?.content).toContain('claude mcp add -s user __PROFILE_ID__ -- npx -y mcp4openapi --profile __PROFILE_ID__');
    expect(claudeLocalCli?.content).not.toContain('export ');
    expect(geminiJson?.format).toBe('json');
    expect(geminiJson?.content).toContain('"mcpServers"');
    expect(geminiJson?.content).toContain('"httpUrl": "__PROFILE_URL__"');
    expect(geminiJson?.content).toContain('"Authorization": "Bearer ${GITLAB_TOKEN}"');
    expect(geminiCli?.format).toBe('cli');
    expect(geminiCli?.content).toContain('gemini mcp add -s user --transport http __PROFILE_ID__ __PROFILE_URL__');
    expect(geminiCli?.content).toContain('Authorization: Bearer \\${GITLAB_TOKEN}');
    expect(geminiLocalJson?.mode).toBe('local');
    expect(geminiLocalJson?.content).toContain('"mcpServers"');
    expect(geminiLocalJson?.content).toContain('"command": "npx"');
    expect(geminiLocalJson?.content).toContain('"args": [');
    expect(geminiLocalJson?.content).not.toContain('"env": {');
    expect(geminiLocalJson?.content).not.toContain('GITLAB_TOKEN');
    expect(geminiLocalCli?.mode).toBe('local');
    expect(geminiLocalCli?.format).toBe('cli');
    expect(geminiLocalCli?.content).toContain('gemini mcp add -s user __PROFILE_ID__ -- npx -y mcp4openapi --profile __PROFILE_ID__');
    expect(codexToml?.format).toBe('toml');
    expect(codexToml?.content).toContain('[mcp_servers.__PROFILE_ID__]');
    expect(codexToml?.content).toContain('transport = "http"');
    expect(codexToml?.content).not.toContain('env_vars = ["GITLAB_TOKEN"]');
    expect(codexToml?.content).toContain('bearer_token_env_var = "GITLAB_TOKEN"');
    expect(codexToml?.content).not.toContain('Authorization =');
    expect(codexCli?.format).toBe('cli');
    expect(codexCli?.content).toContain('codex mcp add --url "__PROFILE_URL__"');
    expect(codexCli?.content).toContain('__PROFILE_ID__');
    expect(codexCli?.content).toContain('--bearer-token-env-var GITLAB_TOKEN');
    expect(codexLocalToml?.format).toBe('toml');
    expect(codexLocalToml?.content).toContain('command = "npx"');
    expect(codexLocalToml?.content).toContain('env_vars = ["GITLAB_TOKEN"]');
    expect(codexLocalToml?.content).not.toContain('GITLAB_TOKEN = "${GITLAB_TOKEN}"');
    expect(codexLocalToml?.content).toContain('GITLAB_API_BASE_URL = "https://gitlab.com/api/v4"');
    expect(profile.snippets.find(s => s.key === 'codex-local-cli-bearer')).toBeUndefined();
  });

  it('resolves API endpoint from env var over default', () => {
    process.env.GITLAB_API_BASE_URL = 'https://env.gitlab.example.com';
    const endpoint = __test__.resolveApiEndpoint({
      profileId: 'gitlab',
      profileName: 'gitlab',
      profileAliases: [],
      envVars: ['GITLAB_API_BASE_URL'],
      authMethods: [],
      apiBaseUrl: {
        valueFromEnv: 'GITLAB_API_BASE_URL',
        defaultValue: 'https://default.gitlab.example.com',
      },
    });

    expect(endpoint).toEqual({
      value: 'https://env.gitlab.example.com',
      source: 'env',
      envVar: 'GITLAB_API_BASE_URL',
    });
    delete process.env.GITLAB_API_BASE_URL;
  });

  it('uses default API endpoint when env var is not set', () => {
    delete process.env.MISSING_BASE_URL;
    const endpoint = __test__.resolveApiEndpoint({
      profileId: 'demo',
      profileName: 'demo',
      profileAliases: [],
      envVars: [],
      authMethods: [],
      apiBaseUrl: {
        valueFromEnv: 'MISSING_BASE_URL',
        defaultValue: 'https://default.example.com',
      },
    });

    expect(endpoint).toEqual({
      value: 'https://default.example.com',
      source: 'default',
      envVar: 'MISSING_BASE_URL',
    });
  });

  it('marks endpoint as env-unset when only env var is configured', () => {
    delete process.env.ONLY_ENV_BASE_URL;
    const endpoint = __test__.resolveApiEndpoint({
      profileId: 'demo',
      profileName: 'demo',
      profileAliases: [],
      envVars: [],
      authMethods: [],
      apiBaseUrl: {
        valueFromEnv: 'ONLY_ENV_BASE_URL',
      },
    });

    expect(endpoint).toEqual({
      value: null,
      source: 'env-unset',
      envVar: 'ONLY_ENV_BASE_URL',
    });
  });

  it('uses query parameters for query auth snippets', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'youtrack',
        profileName: 'youtrack',
        profileAliases: [],
        description: 'YouTrack',
        envVars: ['YT_TOKEN'],
        authMethods: [
          {
            type: 'query',
            queryParam: 'api_key',
            valueFromEnv: 'YT_TOKEN',
          },
        ],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    const vscode = profile.snippets.find(s => s.key === 'vscode-query');
    const cursor = profile.snippets.find(s => s.key === 'cursor-query');
    const jetbrains = profile.snippets.find(s => s.key === 'jetbrains-query');
    const claudeJson = profile.snippets.find(s => s.key === 'claude-json-query');
    const claudeCli = profile.snippets.find(s => s.key === 'claude-cli-query');
    const geminiJson = profile.snippets.find(s => s.key === 'gemini-json-query');
    const geminiCli = profile.snippets.find(s => s.key === 'gemini-cli-query');
    const codexToml = profile.snippets.find(s => s.key === 'codex-toml-query');

    expect(profile.mcpUrl).toBe('http://localhost:3003/profile/youtrack/mcp');
    expect(vscode?.content).toContain('"url": "__PROFILE_URL__?api_key=${input:yt-token}"');
    expect(vscode?.content).not.toContain('"headers"');
    expect(cursor?.content).toContain('"url": "__PROFILE_URL__?api_key=${env:YT_TOKEN}"');
    expect(cursor?.content).not.toContain('"mcp-remote"');
    expect(jetbrains?.content).toContain('"url": "__PROFILE_URL__?api_key={$input:yt-token}"');
    expect(claudeJson?.content).toContain('"url": "__PROFILE_URL__?api_key=${YT_TOKEN}"');
    expect(claudeCli?.content).toContain('__PROFILE_URL__?api_key=\\${YT_TOKEN}');
    expect(geminiJson?.content).toContain('"httpUrl": "__PROFILE_URL__?api_key=${YT_TOKEN}"');
    expect(geminiJson?.content).not.toContain('"headers"');
    expect(geminiCli?.content).toContain('gemini mcp add -s user --transport http __PROFILE_ID__ __PROFILE_URL__?api_key=\\${YT_TOKEN}');
    expect(codexToml?.content).toContain('env_vars = ["YT_TOKEN"]');
    expect(codexToml?.content).toContain('url = "__PROFILE_URL__?api_key=${YT_TOKEN}"');
    expect(profile.snippets.find(s => s.key === 'codex-cli-query')).toBeUndefined();
  });

  it('omits empty Codex local TOML env table when only env_vars are needed', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'collabim-optimized',
        profileName: 'collabim-optimized',
        profileAliases: [],
        description: 'Collabim',
        envVars: ['COLLABIM_TOKEN'],
        authMethods: [
          {
            type: 'bearer',
            valueFromEnv: 'COLLABIM_TOKEN',
          },
        ],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;
    const codexLocalToml = profile.snippets.find(s => s.key === 'codex-local-toml-bearer');

    expect(codexLocalToml?.content).toContain('env_vars = ["COLLABIM_TOKEN"]');
    expect(codexLocalToml?.content).not.toContain('[mcp_servers.__PROFILE_ID__.env]');
  });

  it('ignores oauth-only env vars in local stdio snippets for oauth auth', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'gitlab-optimized-oauth',
        profileName: 'gitlab-optimized-oauth',
        profileAliases: [],
        description: 'GitLab OAuth',
        envVars: ['MCP4_OAUTH_CLIENT_ID', 'MCP4_OAUTH_CLIENT_SECRET', 'GITLAB_API_BASE_URL'],
        oauthEnvVars: ['MCP4_OAUTH_CLIENT_ID', 'MCP4_OAUTH_CLIENT_SECRET'],
        authMethods: [
          {
            type: 'oauth',
          },
        ],
        apiBaseUrl: {
          valueFromEnv: 'GITLAB_API_BASE_URL',
          defaultValue: 'https://gitlab.com/api/v4',
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    const vscodeLocal = profile.snippets.find(s => s.key === 'vscode-local-oauth');
    const cursorLocal = profile.snippets.find(s => s.key === 'cursor-local-oauth');
    const claudeLocalJson = profile.snippets.find(s => s.key === 'claude-local-json-oauth');
    const codexLocalToml = profile.snippets.find(s => s.key === 'codex-local-toml-oauth');

    expect(vscodeLocal?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
    expect(vscodeLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(vscodeLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');

    expect(cursorLocal?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
    expect(cursorLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(cursorLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');

    expect(claudeLocalJson?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
    expect(claudeLocalJson?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(claudeLocalJson?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');

    expect(codexLocalToml?.content).toContain('GITLAB_API_BASE_URL = "https://gitlab.com/api/v4"');
    expect(codexLocalToml?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(codexLocalToml?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');
  });

  it('ignores oauth-only env vars in local stdio snippets for non-oauth auth too', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'gitlab-mixed-auth',
        profileName: 'gitlab-mixed-auth',
        profileAliases: [],
        description: 'GitLab mixed auth',
        envVars: ['MCP4_OAUTH_CLIENT_ID', 'MCP4_OAUTH_CLIENT_SECRET', 'GITLAB_TOKEN', 'GITLAB_API_BASE_URL'],
        oauthEnvVars: ['MCP4_OAUTH_CLIENT_ID', 'MCP4_OAUTH_CLIENT_SECRET'],
        authMethods: [
          {
            type: 'bearer',
            valueFromEnv: 'GITLAB_TOKEN',
          },
        ],
        apiBaseUrl: {
          valueFromEnv: 'GITLAB_API_BASE_URL',
          defaultValue: 'https://gitlab.com/api/v4',
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    const vscodeLocal = profile.snippets.find(s => s.key === 'vscode-local-bearer');
    const cursorLocal = profile.snippets.find(s => s.key === 'cursor-local-bearer');
    const geminiLocalJson = profile.snippets.find(s => s.key === 'gemini-local-json-bearer');
    const codexLocalToml = profile.snippets.find(s => s.key === 'codex-local-toml-bearer');

    expect(vscodeLocal?.content).toContain('"GITLAB_TOKEN": "${input:gitlab-token}"');
    expect(vscodeLocal?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
    expect(vscodeLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(vscodeLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');

    expect(cursorLocal?.content).toContain('"GITLAB_TOKEN": "${env:GITLAB_TOKEN}"');
    expect(cursorLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(cursorLocal?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');

    expect(geminiLocalJson?.content).toContain('"args": [');
    expect(geminiLocalJson?.content).not.toContain('"env": {');
    expect(geminiLocalJson?.content).not.toContain('GITLAB_TOKEN');
    expect(geminiLocalJson?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(geminiLocalJson?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');

    expect(codexLocalToml?.content).toContain('env_vars = ["GITLAB_TOKEN"]');
    expect(codexLocalToml?.content).toContain('GITLAB_API_BASE_URL = "https://gitlab.com/api/v4"');
    expect(codexLocalToml?.content).not.toContain('MCP4_OAUTH_CLIENT_ID');
    expect(codexLocalToml?.content).not.toContain('MCP4_OAUTH_CLIENT_SECRET');
  });

  it('labels custom headers without duplicate prefix', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'n8n',
        profileName: 'n8n',
        profileAliases: [],
        description: 'n8n',
        envVars: ['N8N_TOKEN'],
        authMethods: [
          {
            type: 'custom-header',
            headerName: 'X-N8N-API-KEY',
            valueFromEnv: 'N8N_TOKEN',
          },
        ],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;
    expect(profile.authTabs[0].label).toBe('Custom header: X-N8N-API-KEY');
  });

  it('renders template placeholders', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'demo',
        profileName: 'demo',
        profileAliases: [],
        description: 'Demo',
        envVars: [],
        authMethods: [],
      },
    ];

    const { templateData } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const html = renderProfileIndexHtml('<h1>{{title}}</h1><div>{{profile_data}}</div><span>{{nonce}}</span>', templateData, 'nonce123');
    expect(html).toContain('MCP profiles');
    expect(html).toContain('nonce123');
    expect(html).toContain('"profileId":"demo"');
  });

  it('includes resolved API endpoint in payload', () => {
    process.env.DEMO_API_BASE_URL = 'https://api.demo.example.com';
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'demo',
        profileName: 'demo',
        profileAliases: [],
        description: 'Demo',
        envVars: ['DEMO_API_BASE_URL'],
        authMethods: [],
        apiBaseUrl: {
          valueFromEnv: 'DEMO_API_BASE_URL',
          defaultValue: 'https://fallback.demo.example.com',
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    expect(payload.profiles[0].apiEndpoint).toBe('https://api.demo.example.com');
    expect(payload.profiles[0].apiEndpointSource).toBe('env');
    expect(payload.profiles[0].apiEndpointEnvVar).toBe('DEMO_API_BASE_URL');
    delete process.env.DEMO_API_BASE_URL;
  });

  it('builds Czech i18n labels via payload', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'demo',
        profileName: 'demo',
        profileAliases: [],
        description: 'Demo',
        envVars: [],
        authMethods: [],
      },
    ];

    const { templateData } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'cs');
    expect(templateData.title).toContain('MCP profily');
  });

  it('loads and caches the profile index template', async () => {
    const first = await loadProfileIndexTemplate();
    const second = await loadProfileIndexTemplate();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  it('resolves template root when no package.json is found', () => {
    const root = resolveTemplateRoot('/', () => false);
    expect(root).toBe('/');
  });

  it('exposes helpers for empty inputs', () => {
    expect(__test__.buildInputsBlock([], '  ')).toEqual([]);
    expect(__test__.safeJsonForHtml({ a: '<tag>' })).toContain('\\u003c');
  });

  it('deduplicates input ids when names normalize to same slug', () => {
    const inputs = __test__.buildInputs(['API TOKEN', 'api-token']);
    expect(inputs[0].id).toBe('api-token');
    expect(inputs[1].id).toBe('api-token-2');
  });

  it('includes per-profile tenant summary in payload', () => {
    const profiles: ProfileIndexSourceProfile[] = [
      {
        profileId: 'grafana',
        profileName: 'grafana',
        profileAliases: [],
        description: 'Grafana',
        envVars: [],
        authMethods: [],
        tenantSummary: {
          tenantsEnabled: true,
          selectionHeaderName: 'X-Mcp4-Tenant-Id',
          tenants: [
            {
              tenantId: 'team-a',
              selectorType: 'exact',
              selectorDisplay: 'https://grafana.team-a.ops.iszn.cz/api',
              isDefault: true,
            },
            {
              tenantId: 'team-mask',
              selectorType: 'mask',
              selectorDisplay: 'mask:https://grafana.*.ops.iszn.cz/api',
              isDefault: false,
            },
          ],
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    expect(profile.tenantSummary?.tenantsEnabled).toBe(true);
    expect(profile.tenantSummary?.selectionHeaderName).toBe('X-Mcp4-Tenant-Id');
    expect(profile.tenantSummary?.tenants).toHaveLength(2);
    expect(profile.tenantSummary?.tenants[0].tenantId).toBe('team-a');
    expect(profile.tenantSummary?.tenants[1].selectorType).toBe('mask');
  });

  it('renders tenant picker payload and tenant header injection script markers in HTML', async () => {
    const profiles: ProfileIndexSourceProfile[] = [
      {
        profileId: 'grafana',
        profileName: 'grafana',
        profileAliases: [],
        description: 'Grafana',
        envVars: [],
        authMethods: [],
        tenantSummary: {
          tenantsEnabled: true,
          selectionHeaderName: 'X-Mcp4-Tenant-Id',
          tenants: [
            {
              tenantId: 'team-a',
              selectorType: 'exact',
              selectorDisplay: 'https://grafana.team-a.ops.iszn.cz/api',
              isDefault: true,
            },
          ],
        },
      },
    ];

    const { templateData } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const template = await loadProfileIndexTemplate();
    const html = renderProfileIndexHtml(template, templateData, 'nonce123');

    expect(html).toContain('"tenantSummary":{"tenantsEnabled":true');
    expect(html).toContain('"selectionHeaderName":"X-Mcp4-Tenant-Id"');
    expect(html).toContain('injectTenantHeaderIntoJsonSnippet');
    expect(html).toContain('supportsTenantPicker');
    expect(html).toContain('buildMaskExampleBaseUrl');
    expect(html).toContain('X-Mcp4-Tenant-Id');
    expect(html).toContain('X-Mcp4-Api-Base-Url');
    expect(html).toContain('<your-part>');
    expect(html).toContain('key.startsWith(\'vscode-\')');
    expect(html).toContain('key.startsWith(\'jetbrains-\')');
    expect(html).toContain('key.startsWith(\'claude-json-\')');
    expect(html).toContain('key.startsWith(\'gemini-json-\')');
    expect(html).toContain('key.startsWith(\'codex-toml-\')');
  });
});
