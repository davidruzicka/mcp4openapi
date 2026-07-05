import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  buildProfileIndexPayload,
  parseAcceptLanguage,
  parseSystemNotice,
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
    expect(cursor?.content).toContain('"type": "http"');
    expect(cursor?.content).toContain('"url": "__PROFILE_URL__"');
    expect(cursor?.content).toContain('"Authorization": "Bearer ${env:GITLAB_TOKEN}"');
    expect(cursor?.content).not.toContain('"env": {');
    expect(cursor?.content).not.toContain('"mcp-remote"');
    expect(jetbrains?.content).toContain('"requestInit"');
    expect(jetbrains?.content).toContain('"Authorization": "Bearer ${input:gitlab-token}"');
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
    expect(jetbrainsLocal?.content).toContain('"GITLAB_TOKEN": "${input:gitlab-token}"');
    expect(claudeLocalJson?.mode).toBe('local');
    expect(claudeLocalJson?.format).toBe('json');
    expect(claudeLocalJson?.content).toContain('"mcpServers"');
    expect(claudeLocalJson?.content).toContain('"command": "npx"');
    expect(claudeLocalJson?.content).toContain('"GITLAB_TOKEN": "${GITLAB_TOKEN}"');
    expect(claudeLocalJson?.content).not.toContain('${env:GITLAB_TOKEN}');
    expect(claudeLocalCli?.mode).toBe('local');
    expect(claudeLocalCli?.format).toBe('cli');
    expect(claudeLocalCli?.content).toContain('claude mcp add -s user --env "GITLAB_API_BASE_URL=https://gitlab.com/api/v4" __PROFILE_ID__ -- npx -y mcp4openapi --profile __PROFILE_ID__');
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
    expect(geminiLocalJson?.content).toContain('"env": {');
    expect(geminiLocalJson?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
    expect(geminiLocalJson?.content).not.toContain('GITLAB_TOKEN');
    expect(geminiLocalCli?.mode).toBe('local');
    expect(geminiLocalCli?.format).toBe('cli');
    expect(geminiLocalCli?.content).toContain('gemini mcp add -s user -e "GITLAB_API_BASE_URL=https://gitlab.com/api/v4" __PROFILE_ID__ -- npx -y mcp4openapi --profile __PROFILE_ID__');
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
    expect(vscode?.supportsCustomHeaders).toBe(true);
    expect(vscode?.supportsTenantHeaders).toBe(true);
    expect(codexCli?.supportsCustomHeaders).toBe(false);
    expect(codexLocalToml?.format).toBe('toml');
    expect(codexLocalToml?.content).toContain('command = "npx"');
    expect(codexLocalToml?.content).toContain('env_vars = ["GITLAB_TOKEN"]');
    expect(codexLocalToml?.content).not.toContain('GITLAB_TOKEN = "${GITLAB_TOKEN}"');
    expect(codexLocalToml?.content).toContain('GITLAB_API_BASE_URL = "https://gitlab.com/api/v4"');
    expect(profile.snippets.find(s => s.key === 'codex-local-cli-bearer')).toBeUndefined();
  });

  it('builds token (DRF) snippets with Token prefix in Authorization header', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'defectdojo',
        profileName: 'defectdojo',
        profileAliases: [],
        description: 'DefectDojo',
        envVars: ['DEFECTDOJO_API_BASE_URL', 'DEFECTDOJO_TOKEN'],
        authMethods: [
          {
            type: 'token',
            valueFromEnv: 'DEFECTDOJO_TOKEN',
          },
        ],
        apiBaseUrl: {
          valueFromEnv: 'DEFECTDOJO_API_BASE_URL',
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    const vscode = profile.snippets.find(s => s.key === 'vscode-token');
    const cursor = profile.snippets.find(s => s.key === 'cursor-token');
    const jetbrains = profile.snippets.find(s => s.key === 'jetbrains-token');
    const claudeJson = profile.snippets.find(s => s.key === 'claude-json-token');
    const claudeCli = profile.snippets.find(s => s.key === 'claude-cli-token');
    const geminiJson = profile.snippets.find(s => s.key === 'gemini-json-token');
    const geminiCli = profile.snippets.find(s => s.key === 'gemini-cli-token');
    const codexToml = profile.snippets.find(s => s.key === 'codex-toml-token');
    const codexCli = profile.snippets.find(s => s.key === 'codex-cli-token');
    const vscodeLocal = profile.snippets.find(s => s.key === 'vscode-local-token');
    const authTab = profile.authTabs.find(t => t.key === 'token');

    expect(authTab?.label).toBe('Token (DRF)');
    expect(vscode?.content).toContain('"Authorization": "Token ${input:defectdojo-token}"');
    expect(cursor?.content).toContain('"Authorization": "Token ${env:DEFECTDOJO_TOKEN}"');
    expect(jetbrains?.content).toContain('"Authorization": "Token ${input:defectdojo-token}"');
    expect(claudeJson?.content).toContain('"Authorization": "Token ${DEFECTDOJO_TOKEN}"');
    expect(claudeCli?.content).toContain('Authorization: Token \\${DEFECTDOJO_TOKEN}');
    expect(geminiJson?.content).toContain('"Authorization": "Token ${DEFECTDOJO_TOKEN}"');
    expect(geminiCli?.content).toContain('Authorization: Token \\${DEFECTDOJO_TOKEN}');
    expect(codexToml?.content).toContain('http_headers = { "Authorization" = "Token ${DEFECTDOJO_TOKEN}" }');
    expect(codexToml?.content).not.toContain('bearer_token_env_var');
    expect(codexCli?.content).toContain('--header "Authorization: Token ${DEFECTDOJO_TOKEN}"');
    expect(codexCli?.content).not.toContain('--bearer-token-env-var');
    expect(profile.snippets.find(s => s.key === 'codex-cli-token')).toBeDefined();
    expect(vscodeLocal?.mode).toBe('local');
    expect(vscodeLocal?.content).toContain('"DEFECTDOJO_TOKEN"');
  });

  it('uses Czech i18n label for token auth type', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'defectdojo',
        profileName: 'defectdojo',
        profileAliases: [],
        envVars: ['DEFECTDOJO_API_BASE_URL', 'DEFECTDOJO_TOKEN'],
        authMethods: [{ type: 'token', valueFromEnv: 'DEFECTDOJO_TOKEN' }],
        apiBaseUrl: { valueFromEnv: 'DEFECTDOJO_API_BASE_URL' },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'cs');
    const authTab = payload.profiles[0].authTabs.find(t => t.key === 'token');
    expect(authTab?.label).toBe('Token (DRF)');
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
    expect(cursor?.content).not.toContain('"env": {');
    expect(jetbrains?.content).toContain('"url": "__PROFILE_URL__?api_key=${input:yt-token}"');
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
    expect(geminiLocalJson?.content).toContain('"env": {');
    expect(geminiLocalJson?.content).toContain('"GITLAB_API_BASE_URL": "https://gitlab.com/api/v4"');
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

  it('builds session-cookie snippets only for local stdio', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'n8n-nodes',
        profileName: 'n8n-node-list',
        profileAliases: [],
        description: 'n8n node list',
        envVars: ['N8N_NODES_BASE_URL', 'N8N_NODES_LOGIN_PASSWORD', 'N8N_NODES_LOGIN_USER'],
        authMethods: [
          {
            type: 'session-cookie',
            usernameFromEnv: 'N8N_NODES_LOGIN_USER',
            passwordFromEnv: 'N8N_NODES_LOGIN_PASSWORD',
          },
        ],
        apiBaseUrl: {
          valueFromEnv: 'N8N_NODES_BASE_URL',
          defaultValue: 'https://admin.isatky.cz',
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    expect(profile.modeTabs).toEqual([
      { key: 'local', label: 'Local stdio' },
    ]);
    expect(profile.authTabs[0].label).toBe('Session cookie');
    expect(profile.authTabs.every(t => t.key !== 'oauth')).toBe(true);
    expect(profile.snippets.find(s => s.key === 'vscode-session-cookie')).toBeUndefined();
    expect(profile.snippets.find(s => s.key === 'cursor-session-cookie')).toBeUndefined();

    const vscodeLocal = profile.snippets.find(s => s.key === 'vscode-local-session-cookie');
    const cursorLocal = profile.snippets.find(s => s.key === 'cursor-local-session-cookie');
    const claudeLocalCli = profile.snippets.find(s => s.key === 'claude-local-cli-session-cookie');
    const codexLocalToml = profile.snippets.find(s => s.key === 'codex-local-toml-session-cookie');

    expect(vscodeLocal?.content).toContain('"N8N_NODES_LOGIN_USER": "${N8N_NODES_LOGIN_USER}"');
    expect(vscodeLocal?.content).toContain('"N8N_NODES_LOGIN_PASSWORD": "${input:n8n-nodes-login-password}"');
    expect(vscodeLocal?.content).toContain('"N8N_NODES_BASE_URL": "https://admin.isatky.cz"');
    expect(cursorLocal?.content).toContain('"N8N_NODES_LOGIN_USER": "${env:N8N_NODES_LOGIN_USER}"');
    expect(cursorLocal?.content).toContain('"N8N_NODES_LOGIN_PASSWORD": "${env:N8N_NODES_LOGIN_PASSWORD}"');
    expect(claudeLocalCli?.content).toContain('--env "N8N_NODES_BASE_URL=https://admin.isatky.cz"');
    expect(codexLocalToml?.content).toContain('env_vars = ["N8N_NODES_LOGIN_PASSWORD", "N8N_NODES_LOGIN_USER"]');
    expect(codexLocalToml?.content).toContain('N8N_NODES_BASE_URL = "https://admin.isatky.cz"');
  });

  it('emits authTabs=[none] for proxy profile with no interceptors.auth (regression: no OAuth leak)', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'seznam-scif',
        profileName: 'seznam-scif',
        profileAliases: [],
        description: 'MCP proxy profile for Seznam SCIF',
        envVars: [],
        authMethods: [],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'https://mcp.example.com', 'en');
    const [profile] = payload.profiles;
    expect(profile.authTabs).toHaveLength(1);
    expect(profile.authTabs[0].key).toBe('none');
    expect(profile.authTabs[0].label).toBe('No auth');
    expect(profile.authTabs.every(t => t.key !== 'oauth')).toBe(true);
  });

  it('emits authTabs=[none] with Czech label for no-auth proxy profile', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'seznam-ai-adoption',
        profileName: 'seznam-ai-adoption',
        profileAliases: [],
        description: 'MCP proxy profile for Seznam AI Adoption',
        envVars: [],
        authMethods: [],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'https://mcp.example.com', 'cs');
    const [profile] = payload.profiles;
    expect(profile.authTabs).toHaveLength(1);
    expect(profile.authTabs[0].key).toBe('none');
    expect(profile.authTabs[0].label).toBe('Bez autentizace');
    expect(profile.authTabs.every(t => t.key !== 'oauth')).toBe(true);
  });

  it('does not include oauth authTab even when upstream_mcp env vars are present', () => {
    // Regression: upstream_mcp.auth env vars appear in profile.envVars but must NOT
    // create an oauth auth tab — authMethods reflects only interceptors.auth.
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'proxy-with-upstream-auth',
        profileName: 'proxy-with-upstream-auth',
        profileAliases: [],
        description: 'Proxy with server-to-server upstream auth',
        envVars: ['UPSTREAM_TOKEN'],
        authMethods: [],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'https://mcp.example.com', 'en');
    const [profile] = payload.profiles;
    expect(profile.authTabs).toHaveLength(1);
    expect(profile.authTabs[0].key).toBe('none');
    expect(profile.authTabs.every(t => t.key !== 'oauth')).toBe(true);
    expect(profile.authTabs.every(t => t.key !== 'bearer')).toBe(true);
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

  it('uses env-overridden API endpoint in local snippets', () => {
    process.env.N8N_API_BASE_URL = 'https://admin.isatky.cz/api/v1';
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'n8n-optimized',
        profileName: 'n8n-optimized',
        profileAliases: [],
        description: 'n8n',
        envVars: ['N8N_API_BASE_URL', 'N8N_TOKEN'],
        authMethods: [
          {
            type: 'custom-header',
            headerName: 'X-N8N-API-KEY',
            valueFromEnv: 'N8N_TOKEN',
          },
        ],
        apiBaseUrl: {
          valueFromEnv: 'N8N_API_BASE_URL',
          defaultValue: 'http://localhost:5678/api/v1',
        },
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    const vscodeLocal = profile.snippets.find(s => s.key === 'vscode-local-custom-header');
    const claudeLocalCli = profile.snippets.find(s => s.key === 'claude-local-cli-custom-header');

    expect(vscodeLocal?.content).toContain('"N8N_API_BASE_URL": "https://admin.isatky.cz/api/v1"');
    expect(vscodeLocal?.content).not.toContain('"N8N_API_BASE_URL": "http://localhost:5678/api/v1"');
    expect(claudeLocalCli?.content).toContain('--env "N8N_API_BASE_URL=https://admin.isatky.cz/api/v1"');
    delete process.env.N8N_API_BASE_URL;
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
    expect(first).toContain('profile.apiEndpoint || profile.apiEndpointDefaultValue');
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
            },
            {
              tenantId: 'team-mask',
              selectorType: 'mask',
              selectorDisplay: 'mask:https://grafana.*.ops.iszn.cz/api',
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

  it('includes tool catalog summaries in payload', () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'demo',
        profileName: 'demo',
        profileAliases: [],
        description: 'Demo',
        envVars: [],
        authMethods: [],
        toolCatalog: [
          {
            name: 'manage_demo',
            description: 'Manage demo records.',
            kind: 'simple',
            actions: ['list', 'get'],
            hasActionSelector: true,
            operationCount: 2,
            stepCount: 0,
            parameters: [
              {
                name: 'action',
                typeLabel: 'string',
                description: 'Action selector',
                required: true,
                requiredFor: [],
                isMetadata: true,
                enumValues: ['list', 'get'],
              },
            ],
          },
        ],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    expect(payload.profiles[0].toolCatalog).toEqual([
      {
        name: 'manage_demo',
        description: 'Manage demo records.',
        kind: 'simple',
        actions: ['list', 'get'],
        hasActionSelector: true,
        operationCount: 2,
        stepCount: 0,
        parameters: [
          {
            name: 'action',
            typeLabel: 'string',
            description: 'Action selector',
            required: true,
            requiredFor: [],
            isMetadata: true,
            enumValues: ['list', 'get'],
          },
        ],
      },
    ]);
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
    expect(html).toContain('"supportsCustomHeaders":true');
    expect(html).toContain('injectTenantHeaderIntoJsonSnippet');
    expect(html).toContain('injectFilterHeadersForSnippet');
    expect(html).toContain('injectFilterHeadersIntoJsonSnippet');
    expect(html).toContain('injectFilterHeadersIntoCodexToml');
    expect(html).toContain('buildLocalCliFilterArgs');
    expect(html).toContain('serializeLocalToolFilterAllowNames');
    expect(html).toContain('serializeLocalToolFilterAllowCategories');
    expect(html).toContain('injectLocalFilterConfigForSnippet');
    expect(html).toContain('injectLocalFilterArgsIntoJsonSnippet');
    expect(html).toContain('injectLocalFilterArgsIntoCodexToml');
    expect(html).toContain('injectLocalFilterArgsIntoCliSnippet');
    expect(html).toContain('injectTenantApiBaseUrlIntoJsonSnippet');
    expect(html).toContain('injectTenantApiBaseUrlIntoCodexToml');
    expect(html).toContain('const sectionHeaderRegex = /^\\[mcp_servers\\.[^\\]]+\\.env\\]\\s*$/;');
    expect(html).toContain('const fallbackSectionHeader = `[mcp_servers.${profileId}.env]`;');
    expect(html).toContain('__profile-default__');
    expect(html).toContain('supportsTenantPicker');
    expect(html).toContain('serializeToolFilterHeader');
    expect(html).toContain('serializeParamFilterHeader');
    expect(html).toContain('function hasActiveToolFilter(profileId)');
    expect(html).toContain('function hasActiveParamFilter(profileId)');
    expect(html).toContain('function setBulkToggleState(toggle, selectedCount, totalCount)');
    expect(html).toContain('function syncSectionBulkToggles(detailEl, profile)');
    expect(html).toContain('function wireCollapsibleDetails(root, idPrefix)');
    expect(html).toContain('Tool Filter');
    expect(html).toContain('Parameter Filter');
    expect(html).toContain('Header Preview');
    expect(html).toContain('buildMaskExampleBaseUrl');
    expect(html).toContain('getClientLabel');
    expect(html).toContain('data-client-tab');
    expect(html).toContain('wireClientTabs');
    expect(html).toContain('snippet-section-header');
    expect(html).toContain('active-mode-badge');
    expect(html).toContain('X-Mcp4-Tenant-Id');
    expect(html).toContain('X-Mcp4-Api-Base-Url');
    expect(html).toContain('X-Mcp4-Tools');
    expect(html).toContain('X-Mcp4-Params');
    expect(html).toContain('<your-part>');
    expect(html).not.toContain('ensureCursorMcpRemoteArgs');
    expect(html).not.toContain('upsertCursorHeaderArgInArgs');
    expect(html).toContain('key.startsWith(\'gemini-local-json-\')');
    expect(html).toContain('entry.supportsCustomHeaders');
    expect(html).toContain('entry.supportsTenantHeaders');
    expect(html).toContain("const hasActiveFiltering = hasActiveToolFilter(profile.profileId) || hasActiveParamFilter(profile.profileId);");
    expect(html).toContain("if (hasActiveFiltering && activeMode === 'remote' && !entry.supportsCustomHeaders)");
    expect(html).toContain("if (selectedTenant && activeMode === 'remote' && profile.tenantSummary?.tenantsEnabled && !entry.supportsTenantHeaders)");
    expect(html).toContain("if (hasActiveFiltering && activeMode === 'remote') {");
    expect(html).toContain('args.push(arg);');
    expect(html).toContain('if (allowNames) {');
    expect(html).toContain("cliArgs.push('--tool-filter-allow-names', allowNames);");
    expect(html).toContain("cliArgs.push('--tool-filter-allow-categories', allowCategories);");
    expect(html).toContain("cliArgs.push('--param-filter', paramFilter);");
    expect(html).toContain('values.push(`${name}=${encodeURIComponent(value)}`);');
    expect(html).toContain('CSS.escape(paramName)');
    expect(html).toContain('data-tool-section-toggle');
    expect(html).toContain('data-param-section-toggle');
    expect(html).toContain("toggle.indeterminate = state === 'some';");
    expect(html).toContain("const shouldSelect = target.dataset.bulkState === 'none';");
    expect(html).toContain('const setAllToolFilters = shouldSelect => {');
    expect(html).toContain('const setAllParamFilters = shouldSelect => {');
    expect(html).toContain("summary.setAttribute('role', 'button')");
    expect(html).toContain("summary.setAttribute('aria-controls'");
    expect(html).toContain("summary.setAttribute('aria-expanded'");
    expect(html).toContain('details.addEventListener(\'toggle\', syncState)');
  });

  it('renders filter cards collapsed by default and keeps the header preview hidden until populated', async () => {
    const profiles: ProfileIndexSourceProfile[] = [
      {
        profileId: 'demo',
        profileName: 'demo',
        profileAliases: [],
        description: 'Demo',
        envVars: [],
        authMethods: [],
        toolCatalog: [
          {
            name: 'manage_demo',
            description: 'Manage demo records.',
            kind: 'simple',
            actions: ['list'],
            hasActionSelector: false,
            operationCount: 1,
            stepCount: 0,
            parameters: [
              {
                name: 'query',
                typeLabel: 'string',
                description: 'Search text',
                required: false,
                requiredFor: [],
                isMetadata: false,
                supportsFilterHeader: true,
              },
              {
                name: 'managed_scan_config.diff_scan.enabled',
                typeLabel: 'boolean',
                description: 'Unsafe dotted key',
                required: false,
                requiredFor: [],
                isMetadata: false,
                supportsFilterHeader: false,
              },
            ],
          },
        ],
      },
    ];

    const { templateData } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const template = await loadProfileIndexTemplate();
    const html = renderProfileIndexHtml(template, templateData, 'nonce123');

    expect(html).toContain('<details class="detail-card filter-card">');
    expect(html).not.toContain('<details class="detail-card filter-card" open>');
    expect(html).toContain('const hasPreview = Boolean(toolHeader || paramHeader);');
    expect(html).toContain('id="filter-preview-card"${hasPreview ? \'\' : \' hidden\'}');
    expect(html).toContain('data-tool-search');
    expect(html).toContain('data-param-search');
    expect(html).toContain('Text filter');
    expect(html).toContain('"supportsFilterHeader":true');
    expect(html).toContain('"supportsFilterHeader":false');
    expect(html).toContain('if (parameter.supportsFilterHeader === false) continue;');
  });

  it('hides filter cards for profiles with empty toolCatalog (guard code present in template)', async () => {
    const template = await loadProfileIndexTemplate();

    expect(template).toContain("if (catalog.length === 0) return '';");
    expect(template).toContain("if (parameters.length === 0) return '';");
  });

  it('does not emit oauth authTab when OAuth is not in authMethods (operationally degraded)', () => {
    // Simulates the output after profile-resolver filters out OAuth due to incomplete config.
    // The authMethods no longer contain an oauth entry, so the index must NOT emit an oauth tab.
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'degraded-oauth-profile',
        profileName: 'degraded-oauth-profile',
        profileAliases: [],
        description: 'Profile with degraded OAuth (missing env vars)',
        envVars: ['OAUTH_ISSUER', 'API_TOKEN'],
        oauthEnvVars: ['OAUTH_ISSUER'],
        // OAuth entry was filtered by profile-resolver (isOAuthConfigOperational returned false)
        authMethods: [
          {
            type: 'bearer',
            valueFromEnv: 'API_TOKEN',
            headerName: undefined,
            queryParam: undefined,
          },
        ],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    // No oauth authTab because authMethods has no oauth entry
    expect(profile.authTabs.every(t => t.key !== 'oauth')).toBe(true);
    // Bearer tab is present
    expect(profile.authTabs.some(t => t.key === 'bearer')).toBe(true);
  });
});

describe('adminDescription enrichment (Phase 03.2)', () => {
  const fixture: ListedProfileDetails[] = [
    {
      profileId: 'gitlab',
      profileName: 'gitlab',
      profileAliases: ['gl'],
      description: 'GitLab profile description',
      envVars: ['GITLAB_TOKEN'],
      authMethods: [{ type: 'bearer', valueFromEnv: 'GITLAB_TOKEN' }],
    },
    {
      profileId: 'github',
      profileName: 'github',
      profileAliases: [],
      description: 'GitHub profile description',
      envVars: ['GITHUB_TOKEN'],
      authMethods: [{ type: 'bearer', valueFromEnv: 'GITHUB_TOKEN' }],
    },
  ];

  it('D-10 (back-compat): omitting adminDescriptions arg leaves adminDescription undefined', () => {
    const { payload } = buildProfileIndexPayload(fixture, 'http://localhost:3003', 'en');
    for (const p of payload.profiles) {
      expect(p.adminDescription).toBeUndefined();
    }
  });

  it('D-08 / D-10: passing undefined adminDescriptions leaves adminDescription undefined', () => {
    const { payload } = buildProfileIndexPayload(fixture, 'http://localhost:3003', 'en', undefined);
    for (const p of payload.profiles) {
      expect(p.adminDescription).toBeUndefined();
    }
  });

  it('D-10: matching map key sets adminDescription to the raw HTML value', () => {
    const map = new Map<string, string>([['gitlab', '<b>hi</b>']]);
    const { payload } = buildProfileIndexPayload(fixture, 'http://localhost:3003', 'en', map);
    const gitlab = payload.profiles.find(p => p.profileId === 'gitlab');
    const github = payload.profiles.find(p => p.profileId === 'github');
    expect(gitlab?.adminDescription).toBe('<b>hi</b>');
    expect(github?.adminDescription).toBeUndefined();
  });

  it('D-09: map keys with no matching profileId do not enrich any profile', () => {
    const map = new Map<string, string>([['nonexistent', 'orphan']]);
    const { payload } = buildProfileIndexPayload(fixture, 'http://localhost:3003', 'en', map);
    for (const p of payload.profiles) {
      expect(p.adminDescription).toBeUndefined();
    }
  });

  it('D-06 / D-12: raw HTML survives the safeJsonForHtml embed in templateData.profile_data', () => {
    const map = new Map<string, string>([['gitlab', '<a href="https://x.example/">link</a>']]);
    const { templateData } = buildProfileIndexPayload(fixture, 'http://localhost:3003', 'en', map);
    // safeJsonForHtml escapes ALL "<" → "<" to prevent XSS via HTML tag injection.
    // The value is embedded in a JSON string inside the HTML, so angle brackets must be escaped.
    // Verify the admin description value is present in the payload (with escaping applied).
    expect(templateData.profile_data).toContain('\\u003ca href=');
    // The closing tag is also escaped. Verify the structure is there.
    expect(templateData.profile_data).toContain('\\u003c/a>');
    // ">" is NOT unicode-escaped — safeJsonForHtml only escapes "<", not ">".
    expect(templateData.profile_data).not.toContain('\\u003e');
  });

  it('D-10: empty-string admin description flows through to enrichment as empty string', () => {
    const map = new Map<string, string>([['gitlab', '']]);
    const { payload } = buildProfileIndexPayload(fixture, 'http://localhost:3003', 'en', map);
    const gitlab = payload.profiles.find(p => p.profileId === 'gitlab');
    expect(gitlab?.adminDescription).toBe('');
  });

  it('D-08: empty Map (defined but empty) leaves adminDescription undefined', () => {
    const { payload } = buildProfileIndexPayload(fixture, 'http://localhost:3003', 'en', new Map());
    for (const p of payload.profiles) {
      expect(p.adminDescription).toBeUndefined();
    }
  });

  it('D-11: html/profile-index.html renderList body does NOT reference adminDescription', () => {
    // Why: D-11 forbids the sidebar list item from showing the admin description.
    // Lock this with a structural check on the template so a future edit cannot regress it.
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    // profile-index.test.ts lives at src/transport/, template lives at <repo>/html/profile-index.html
    let dir = moduleDir;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('repo root not found');
      dir = parent;
    }
    const html = fs.readFileSync(path.join(dir, 'html', 'profile-index.html'), 'utf-8');
    const listStart = html.indexOf('function renderList(');
    expect(listStart).toBeGreaterThan(-1);
    // Slice from `function renderList(` to the next `function ` after it.
    const afterListStart = listStart + 'function renderList('.length;
    const nextFnRel = html.slice(afterListStart).search(/\n\s{6}function\s/);
    expect(nextFnRel).toBeGreaterThan(-1);
    const renderListBody = html.slice(listStart, afterListStart + nextFnRel);
    expect(renderListBody).not.toContain('adminDescription');
  });
});

describe('Phase 03.2 HTML rendering', () => {
  function repoRoot(): string {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    let dir = moduleDir;
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('repo root not found');
      dir = parent;
    }
    return dir;
  }

  function readTemplate(): string {
    return fs.readFileSync(path.join(repoRoot(), 'html', 'profile-index.html'), 'utf-8');
  }

  function sliceRenderDetail(html: string): string {
    const start = html.indexOf('function renderDetail(');
    if (start < 0) throw new Error('renderDetail not found');
    const after = start + 'function renderDetail('.length;
    // Match the next function definition at the same nesting (6 leading spaces) — same heuristic
    // used by the renderList grep test added in Plan 02.
    const nextRel = html.slice(after).search(/\n\s{6}function\s/);
    if (nextRel < 0) throw new Error('end of renderDetail not found');
    return html.slice(start, after + nextRel);
  }

  it('D-06 / D-12: raw HTML in adminDescription survives end-to-end through renderProfileIndexHtml', async () => {
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'gitlab',
        profileName: 'gitlab',
        profileAliases: [],
        description: 'GitLab',
        envVars: ['GITLAB_TOKEN'],
        authMethods: [{ type: 'bearer', valueFromEnv: 'GITLAB_TOKEN' }],
      },
    ];
    const adminDescriptions = new Map<string, string>([
      ['gitlab', '<a href="https://x.example/">link</a>'],
    ]);
    const { templateData } = buildProfileIndexPayload(
      profiles,
      'http://localhost:3003',
      'en',
      adminDescriptions,
    );
    const template = await loadProfileIndexTemplate();
    const rendered = renderProfileIndexHtml(template, templateData, 'test-nonce');

    // Why: profile_data is embedded as a JSON string literal inside a <script> tag.
    // safeJsonForHtml escapes ALL "<" to "<" (6 literal chars) to prevent HTML tag injection.
    // JSON also escapes double quotes inside the string to \". ">" is NOT escaped (only "<" is).
    // So the literal we expect in the rendered HTML is:
    //   <a href=\"https://x.example/\">link</a>
    // This string proves raw HTML survives — no &lt;, no &amp;quot;.
    expect(rendered).toContain('\\u003ca href=\\"https://x.example/\\">link\\u003c/a>');
    // Negative: must NOT contain any HTML-entity-encoded form of the link.
    expect(rendered).not.toContain('&lt;a href');
    expect(rendered).not.toContain('&amp;lt;a href');
  });

  it('D-12: renderDetail interpolates profile.adminDescription WITHOUT escapeHtml wrapper', () => {
    const html = readTemplate();
    const renderDetailBody = sliceRenderDetail(html);
    // The field must be referenced at least once.
    expect(renderDetailBody).toContain('profile.adminDescription');
    // It must NEVER be wrapped in escapeHtml in the renderDetail body.
    expect(renderDetailBody).not.toMatch(/escapeHtml\(\s*profile\.adminDescription/);
  });

  it('D-10: admin-description div appears BEFORE the existing escaped description div', () => {
    const html = readTemplate();
    const renderDetailBody = sliceRenderDetail(html);
    const adminIdx = renderDetailBody.indexOf('profile-admin-description');
    const descIdx = renderDetailBody.indexOf('${escapeHtml(description)}');
    expect(adminIdx).toBeGreaterThan(-1);
    expect(descIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeLessThan(descIdx);
  });

  it('D-08 / truthy guard: undefined adminDescription absent from embedded profile_data JSON', async () => {
    // The template JS source always contains the string "profile-admin-description" as a literal,
    // so we cannot check rendered HTML directly. Instead we verify that when adminDescription is
    // undefined, JSON.stringify omits the key from the profile_data blob — meaning the client-side
    // truthy guard `profile.adminDescription ?` will evaluate falsy and emit no div.
    const profiles: ListedProfileDetails[] = [
      {
        profileId: 'gitlab',
        profileName: 'gitlab',
        profileAliases: [],
        description: 'GitLab',
        envVars: ['GITLAB_TOKEN'],
        authMethods: [{ type: 'bearer', valueFromEnv: 'GITLAB_TOKEN' }],
      },
    ];
    const { templateData } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const template = await loadProfileIndexTemplate();
    const rendered = renderProfileIndexHtml(template, templateData, 'test-nonce');
    expect(rendered).not.toContain('"adminDescription"');
  });
});

describe('parseSystemNotice', () => {
  it('returns null for undefined', () => {
    expect(parseSystemNotice(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSystemNotice('')).toBeNull();
    expect(parseSystemNotice('   ')).toBeNull();
  });

  it('parses plain string as info', () => {
    expect(parseSystemNotice('Maintenance Monday')).toEqual({ message: 'Maintenance Monday', severity: 'info' });
  });

  it('parses JSON with warning severity', () => {
    expect(parseSystemNotice('{"message":"Výpadek v 18:00","severity":"warning"}')).toEqual({
      message: 'Výpadek v 18:00',
      severity: 'warning',
    });
  });

  it('parses JSON with error severity', () => {
    expect(parseSystemNotice('{"message":"Critical outage","severity":"error"}')).toEqual({
      message: 'Critical outage',
      severity: 'error',
    });
  });

  it('falls back to info for unknown severity', () => {
    expect(parseSystemNotice('{"message":"Test","severity":"critical"}')).toEqual({
      message: 'Test',
      severity: 'info',
    });
  });

  it('falls back to info when severity missing from JSON', () => {
    expect(parseSystemNotice('{"message":"Test"}')).toEqual({ message: 'Test', severity: 'info' });
  });

  it('throws ConfigurationError when JSON message is not a string', () => {
    expect(() => parseSystemNotice('{"message":42}')).toThrow('MCP4_SYSTEM_NOTICE JSON must have a string "message" field');
  });

  it('throws ConfigurationError when message exceeds 2000 chars', () => {
    const long = 'x'.repeat(2001);
    expect(() => parseSystemNotice(long)).toThrow('MCP4_SYSTEM_NOTICE message must not exceed 2000 characters');
  });

  it('throws ConfigurationError when JSON message exceeds 2000 chars', () => {
    const long = 'x'.repeat(2001);
    expect(() => parseSystemNotice(JSON.stringify({ message: long, severity: 'info' }))).toThrow(
      'MCP4_SYSTEM_NOTICE message must not exceed 2000 characters'
    );
  });
});

describe('system_notice in template', () => {
  const minimalProfile: ListedProfileDetails = {
    profileId: 'test',
    profileName: 'test',
    profileAliases: [],
    description: 'Test',
    envVars: [],
    authMethods: [{ type: 'bearer', valueFromEnv: 'TOKEN' }],
  };

  it('system_notice empty when no notice passed', () => {
    const { templateData } = buildProfileIndexPayload([minimalProfile], 'http://localhost', 'en');
    expect(templateData.system_notice).toBe('');
  });

  it('system_notice empty when null passed', () => {
    const { templateData } = buildProfileIndexPayload([minimalProfile], 'http://localhost', 'en', undefined, null);
    expect(templateData.system_notice).toBe('');
  });

  it('system_notice renders info banner', () => {
    const { templateData } = buildProfileIndexPayload(
      [minimalProfile], 'http://localhost', 'en', undefined,
      { message: 'Hello world', severity: 'info' }
    );
    expect(templateData.system_notice).toBe(
      '<div class="system-notice system-notice--info" role="alert">Hello world</div>'
    );
  });

  it('system_notice renders warning banner', () => {
    const { templateData } = buildProfileIndexPayload(
      [minimalProfile], 'http://localhost', 'en', undefined,
      { message: 'Maintenance at 22:00', severity: 'warning' }
    );
    expect(templateData.system_notice).toContain('system-notice--warning');
    expect(templateData.system_notice).toContain('Maintenance at 22:00');
  });

  it('system_notice HTML-escapes message', () => {
    const { templateData } = buildProfileIndexPayload(
      [minimalProfile], 'http://localhost', 'en', undefined,
      { message: '<script>alert("xss")</script>', severity: 'error' }
    );
    expect(templateData.system_notice).not.toContain('<script>');
    expect(templateData.system_notice).toContain('&lt;script&gt;');
  });

  it('rendered HTML contains notice div', async () => {
    const { templateData } = buildProfileIndexPayload(
      [minimalProfile], 'http://localhost', 'en', undefined,
      { message: 'System maintenance', severity: 'warning' }
    );
    const template = await loadProfileIndexTemplate();
    const rendered = renderProfileIndexHtml(template, templateData, 'test-nonce');
    expect(rendered).toContain('system-notice--warning');
    expect(rendered).toContain('System maintenance');
  });

  it('rendered HTML has no notice div when not configured', async () => {
    const { templateData } = buildProfileIndexPayload([minimalProfile], 'http://localhost', 'en');
    const template = await loadProfileIndexTemplate();
    const rendered = renderProfileIndexHtml(template, templateData, 'test-nonce');
    expect(rendered).not.toContain('class="system-notice');
  });
});
