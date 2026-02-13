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
        envVars: ['GITLAB_TOKEN'],
        authMethods: [
          {
            type: 'bearer',
            valueFromEnv: 'GITLAB_TOKEN',
          },
        ],
      },
    ];

    const { payload } = buildProfileIndexPayload(profiles, 'http://localhost:3003', 'en');
    const [profile] = payload.profiles;

    const vscode = profile.snippets.find(s => s.key === 'vscode-bearer');
    const cursor = profile.snippets.find(s => s.key === 'cursor-bearer');
    const jetbrains = profile.snippets.find(s => s.key === 'jetbrains-bearer');
    const claude = profile.snippets.find(s => s.key === 'claude-bearer');

    expect(profile.mcpUrl).toBe('http://localhost:3003/profile/gitlab/mcp');
    expect(vscode?.content).toContain('"url": "__PROFILE_URL__"');
    expect(vscode?.content).toContain('"Authorization": "Bearer ${input:gitlab-token}"');
    expect(cursor?.content).toContain('"mcp-remote"');
    expect(cursor?.content).toContain('"Authorization: Bearer ${env:GITLAB_TOKEN}"');
    expect(cursor?.content).toContain('"GITLAB_TOKEN": "${env:GITLAB_TOKEN}"');
    expect(jetbrains?.content).toContain('"requestInit"');
    expect(jetbrains?.content).toContain('"Authorization": "Bearer {$input:gitlab-token}"');
    expect(claude?.content).toContain('claude mcp add __PROFILE_ID__ --transport http __PROFILE_URL__');
    expect(claude?.content).toContain('Authorization: Bearer ${GITLAB_TOKEN}');
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
    const claude = profile.snippets.find(s => s.key === 'claude-query');

    expect(profile.mcpUrl).toBe('http://localhost:3003/profile/youtrack/mcp');
    expect(vscode?.content).toContain('"url": "__PROFILE_URL__?api_key=${input:yt-token}"');
    expect(vscode?.content).not.toContain('"headers"');
    expect(cursor?.content).toContain('"url": "__PROFILE_URL__?api_key=${env:YT_TOKEN}"');
    expect(cursor?.content).not.toContain('"mcp-remote"');
    expect(jetbrains?.content).toContain('"url": "__PROFILE_URL__?api_key={$input:yt-token}"');
    expect(claude?.content).toContain('__PROFILE_URL__?api_key=${YT_TOKEN}');
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
});
