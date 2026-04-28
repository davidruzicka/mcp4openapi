import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtmlSafe } from '../validation/validation-utils.js';
import type { ListedProfileDetails, ProfileAuthMethod } from '../profile/profile-resolver.js';
import type { TenantSelectorType } from '../types/http-tenants.js';

export type ProfileIndexLocale = 'cs' | 'en';

interface ProfileIndexI18n {
  title: string;
  subtitle: string;
  noscript: string;
  profileLabel: string;
  endpointLabel: string;
  apiEndpointLabel: string;
  sseDeprecatedLabel: string;
  apiEndpointDefaultTag: string;
  apiEndpointVariableLabel: string;
  apiEndpointUnavailableInline: string;
  apiEndpointSourceEnv: string;
  apiEndpointSourceDefault: string;
  apiEndpointEnvNotSet: string;
  apiEndpointUnavailable: string;
  envVarsLabel: string;
  envNote: string;
  noEnvVars: string;
  noDescription: string;
  noProfiles: string;
  copy: string;
  copied: string;
  copyFailed: string;
  snippetLabels: {
    minimal: string;
    vscode: string;
    cursor: string;
    claude: string;
    gemini: string;
    codex: string;
    jetbrains: string;
    modeRemote: string;
    modeLocal: string;
  };
  authLabels: {
    oauth: string;
    bearer: string;
    query: string;
    customHeader: string;
    sessionCookie: string;
    none: string;
  };
  authSectionLabel: string;
  authEnvVarsLabel: string;
  authEnvVarsNone: string;
  authHeaderPrefix: string;
  authQueryPrefix: string;
  tenantSectionLabel: string;
  tenantsAvailableLabel: string;
  tenantHeaderLabel: string;
  tenantSelectorLabel: string;
  tenantMaskNote: string;
  tenantPickerScopeLabel: string;
  tenantProfileDefaultLabel: string;
  tenantProfileDefaultNote: string;
}

interface ProfileIndexSnippet {
  key: string;
  label: string;
  content: string;
  authKey: string;
  mode: 'remote' | 'local';
  format: 'json' | 'cli' | 'toml';
  supportsCustomHeaders: boolean;
  supportsTenantHeaders: boolean;
}

type ProfileIndexSnippetDraft = Omit<ProfileIndexSnippet, 'supportsCustomHeaders' | 'supportsTenantHeaders'>;

interface ProfileIndexTab {
  key: string;
  label: string;
}

type RenderAuthMethod = ProfileAuthMethod | { type: 'none' };

export interface ProfileIndexTenantSummary {
  tenantsEnabled: boolean;
  selectionHeaderName: 'X-Mcp4-Tenant-Id';
  tenants: Array<{
    tenantId: string;
    selectorType: TenantSelectorType;
    selectorDisplay: string;
  }>;
}

export interface ProfileIndexSourceProfile extends ListedProfileDetails {
  tenantSummary?: ProfileIndexTenantSummary;
}

interface ProfileIndexProfile extends ListedProfileDetails {
  mcpUrl: string;
  sseUrl: string;
  apiEndpoint: string | null;
  apiEndpointDefaultValue: string | null;
  apiEndpointSource: 'env' | 'default' | 'env-unset' | 'unavailable';
  apiEndpointEnvVar: string | null;
  snippets: ProfileIndexSnippet[];
  authTabs: ProfileIndexTab[];
  modeTabs: ProfileIndexTab[];
  tenantSummary?: ProfileIndexTenantSummary;
}

export interface ProfileIndexPayload {
  profiles: ProfileIndexProfile[];
  origin: string;
}

let cachedTemplate: string | null = null;

export function parseAcceptLanguage(headerValue?: string): ProfileIndexLocale {
  if (!headerValue) return 'en';
  const normalized = headerValue.toLowerCase();
  if (normalized.includes('cs')) return 'cs';
  return 'en';
}

export async function loadProfileIndexTemplate(): Promise<string> {
  if (cachedTemplate) {
    return cachedTemplate;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = resolveTemplateRoot(moduleDir);
  const templatePath = path.join(rootDir, 'html', 'profile-index.html');
  const template = await fs.promises.readFile(templatePath, 'utf-8');
  cachedTemplate = template;
  return template;
}

export function resolveTemplateRoot(startDir: string, existsSyncFn: (path: string) => boolean = fs.existsSync): string {
  let current = startDir;
  while (true) {
    if (existsSyncFn(path.join(current, 'package.json'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderTemplate(template: string, replacements: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(replacements)) {
    const pattern = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    rendered = rendered.replace(pattern, value);
  }
  return rendered;
}

export function buildProfileIndexI18n(locale: ProfileIndexLocale): ProfileIndexI18n {
  if (locale === 'cs') {
    return {
      title: 'MCP profily',
      subtitle: 'Přehled dostupných MCP profilů a rychlé návody k připojení.',
      noscript: 'Pro zobrazení návodu je potřeba zapnout JavaScript.',
      profileLabel: 'Profil',
      endpointLabel: 'Endpointy',
      apiEndpointLabel: 'API endpoint',
      sseDeprecatedLabel: '(zastaralé)',
      apiEndpointDefaultTag: '(default)',
      apiEndpointVariableLabel: 'proměnná',
      apiEndpointUnavailableInline: 'není nakonfigurován',
      apiEndpointSourceEnv: 'Zdroj: env',
      apiEndpointSourceDefault: 'Zdroj: default',
      apiEndpointEnvNotSet: 'Proměnná není nastavena',
      apiEndpointUnavailable: 'Endpoint není v profilu nakonfigurován.',
      envVarsLabel: 'Proměnné prostředí',
      envNote: 'Hodnoty proměnných prostředí lze zadat přes env. Parametry CLI podporují pouze MCP4_* (např. --api-base-url).',
      noEnvVars: 'V profilu nejsou detekované žádné proměnné prostředí.',
      noDescription: 'Bez popisu.',
      noProfiles: 'Žádné profily nebyly nalezeny.',
      copy: 'Kopírovat',
      copied: 'Zkopírováno',
      copyFailed: 'Nelze zkopírovat',
      snippetLabels: {
        minimal: 'Minimální připojení',
        vscode: 'VS Code + Copilot',
        cursor: 'Cursor',
        claude: 'Claude Code',
        gemini: 'Gemini CLI',
        codex: 'Codex',
        jetbrains: 'JetBrains IDEs + Copilot',
        modeRemote: 'Remote HTTP',
        modeLocal: 'Local stdio',
      },
      authLabels: {
        oauth: 'OAuth',
        bearer: 'Bearer',
        query: 'Token (query)',
        customHeader: 'Vlastní hlavička',
        sessionCookie: 'Session cookie',
        none: 'Bez autentizace',
      },
      authSectionLabel: 'Autentizace:',
      authEnvVarsLabel: 'Proměnná prostředí:',
      authEnvVarsNone: 'Bez proměnné prostředí',
      authHeaderPrefix: 'Hlavička',
      authQueryPrefix: 'Parametr',
      tenantSectionLabel: 'Tenanti',
      tenantsAvailableLabel: 'Dostupní tenanti',
      tenantHeaderLabel: 'Hlavička pro výběr',
      tenantSelectorLabel: 'Selektor',
      tenantMaskNote: 'Tenant se selektorem mask: vyžaduje při inicializaci také konkrétní X-Mcp4-Api-Base-Url.',
      tenantPickerScopeLabel: 'Interaktivní výběr tenanta je dostupný jen pro klienty s ověřenou podporou vlastních hlaviček.',
      tenantProfileDefaultLabel: 'Bez tenanta (použít konfiguraci profilu)',
      tenantProfileDefaultNote: 'Do konfigurace se nepřidá X-Mcp4-Tenant-Id ani X-Mcp4-Api-Base-Url.',
    };
  }

  return {
    title: 'MCP profiles',
    subtitle: 'Available MCP profiles and quick connection guides.',
    noscript: 'Enable JavaScript to view the instructions.',
    profileLabel: 'Profile',
    endpointLabel: 'Endpoints',
    apiEndpointLabel: 'API endpoint',
    sseDeprecatedLabel: '(deprecated)',
    apiEndpointDefaultTag: '(default)',
    apiEndpointVariableLabel: 'variable',
    apiEndpointUnavailableInline: 'is not configured',
    apiEndpointSourceEnv: 'Source: env',
    apiEndpointSourceDefault: 'Source: default',
    apiEndpointEnvNotSet: 'Environment variable is not set',
    apiEndpointUnavailable: 'API endpoint is not configured in the profile.',
    envVarsLabel: 'Environment variables',
    envNote: 'Values can be provided via env vars. CLI parameters only support MCP4_* (for example --api-base-url).',
    noEnvVars: 'No environment variables detected for this profile.',
    noDescription: 'No description.',
    noProfiles: 'No profiles were found.',
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    snippetLabels: {
      minimal: 'Minimal connection',
      vscode: 'VS Code + Copilot',
      cursor: 'Cursor',
      claude: 'Claude Code',
      gemini: 'Gemini CLI',
      codex: 'Codex',
      jetbrains: 'JetBrains IDEs + Copilot',
      modeRemote: 'Remote HTTP',
      modeLocal: 'Local stdio',
    },
    authLabels: {
      oauth: 'OAuth',
      bearer: 'Bearer',
      query: 'Token (query)',
      customHeader: 'Custom header',
      sessionCookie: 'Session cookie',
      none: 'No auth',
    },
    authSectionLabel: 'Authentication:',
    authEnvVarsLabel: 'Environment variable:',
    authEnvVarsNone: 'No environment variable required',
    authHeaderPrefix: 'Header',
    authQueryPrefix: 'Query param',
    tenantSectionLabel: 'Tenants',
    tenantsAvailableLabel: 'Available tenants',
    tenantHeaderLabel: 'Selection header',
    tenantSelectorLabel: 'Selector',
    tenantMaskNote: 'Tenants configured with mask: also require concrete X-Mcp4-Api-Base-Url on initialization.',
    tenantPickerScopeLabel: 'Interactive tenant picker is available only for clients with verified custom-header support.',
    tenantProfileDefaultLabel: 'No tenant (use profile config)',
    tenantProfileDefaultNote: 'X-Mcp4-Tenant-Id and X-Mcp4-Api-Base-Url will not be added to the snippet.',
  };
}

export function buildProfileIndexPayload(
  profiles: ProfileIndexSourceProfile[],
  origin: string,
  locale: ProfileIndexLocale
): { payload: ProfileIndexPayload; templateData: Record<string, string> } {
  const i18n = buildProfileIndexI18n(locale);
  const enriched = profiles.map(profile => {
    const { snippets, authTabs, modeTabs } = buildProfileSnippets(profile, i18n);
    const apiEndpointInfo = resolveApiEndpoint(profile);
    return {
      ...profile,
      mcpUrl: `${origin}/profile/${encodeURIComponent(profile.profileId)}/mcp`,
      sseUrl: `${origin}/profile/${encodeURIComponent(profile.profileId)}/sse`,
      apiEndpoint: apiEndpointInfo.value,
      apiEndpointDefaultValue: profile.apiBaseUrl?.defaultValue || null,
      apiEndpointSource: apiEndpointInfo.source,
      apiEndpointEnvVar: apiEndpointInfo.envVar,
      snippets,
      authTabs,
      modeTabs,
      tenantSummary: profile.tenantSummary,
      toolCatalog: profile.toolCatalog || [],
    };
  });

  const payload: ProfileIndexPayload = {
    profiles: enriched,
    origin,
  };

  const templateData = {
    lang: locale,
    title: escapeHtmlSafe(i18n.title),
    subtitle: escapeHtmlSafe(i18n.subtitle),
    noscript: escapeHtmlSafe(i18n.noscript),
    profile_data: safeJsonForHtml(enriched),
    i18n_data: safeJsonForHtml(i18n),
  };

  return { payload, templateData };
}

function resolveApiEndpoint(
  profile: ListedProfileDetails
): { value: string | null; source: 'env' | 'default' | 'env-unset' | 'unavailable'; envVar: string | null } {
  const { envVar: valueFromEnv, envValue, defaultValue } = resolveConfiguredApiBaseUrl(profile);

  if (valueFromEnv) {
    if (envValue) {
      return {
        value: envValue,
        source: 'env',
        envVar: valueFromEnv,
      };
    }
    if (defaultValue) {
      return {
        value: defaultValue,
        source: 'default',
        envVar: valueFromEnv,
      };
    }
    return {
      value: null,
      source: 'env-unset',
      envVar: valueFromEnv,
    };
  }

  if (defaultValue) {
    return {
      value: defaultValue,
      source: 'default',
      envVar: null,
    };
  }

  return {
    value: null,
    source: 'unavailable',
    envVar: null,
  };
}

function resolveConfiguredApiBaseUrl(
  profile: ListedProfileDetails
): { envVar: string | null; envValue: string | null; defaultValue: string | null } {
  const envVar = profile.apiBaseUrl?.valueFromEnv?.trim() || null;
  const envValue = envVar ? process.env[envVar]?.trim() || null : null;
  const defaultValue = profile.apiBaseUrl?.defaultValue?.trim() || null;
  return { envVar, envValue, defaultValue };
}

export function renderProfileIndexHtml(template: string, templateData: Record<string, string>, nonce: string): string {
  const html = renderTemplate(template, {
    ...templateData,
    nonce: escapeHtmlSafe(nonce),
  });
  return html;
}

function isSensitiveEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  return /(SECRET|PASSWORD|PASS|TOKEN|KEY)/.test(upper);
}

function createInputId(name: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  let id = base || 'secret';
  let counter = 1;
  while (used.has(id)) {
    counter += 1;
    id = `${base}-${counter}`;
  }
  used.add(id);
  return id;
}

function buildInputs(envVars: string[]): Array<{ id: string; description: string }> {
  const used = new Set<string>();
  return envVars.map(name => ({
    id: createInputId(name, used),
    description: name,
  }));
}

function buildEnvValue(
  name: string,
  inputMap: Map<string, string>,
  useInput: boolean,
  mode: 'vscode' | 'cursor' | 'jetbrains' | 'cli'
): string {
  if (mode === 'cli') {
    return `\${${name}}`;
  }
  if (mode === 'cursor') {
    return `\${env:${name}}`;
  }
  if (useInput) {
    const id = inputMap.get(name);
    if (id) {
      return `\${input:${id}}`;
    }
  }
  return `\${${name}}`;
}

function appendComma(lines: string[]): void {
  if (lines.length === 0) return;
  lines[lines.length - 1] = `${lines[lines.length - 1]},`;
}

function buildAuthLabel(auth: RenderAuthMethod, labels: ProfileIndexI18n): string {
  if (auth.type === 'oauth') return labels.authLabels.oauth;
  if (auth.type === 'bearer') return labels.authLabels.bearer;
  if (auth.type === 'query') {
    const suffix = auth.queryParam ? `: ${auth.queryParam}` : '';
    return `${labels.authLabels.query}${suffix}`.trim();
  }
  if (auth.type === 'custom-header') {
    const suffix = auth.headerName ? `: ${auth.headerName}` : '';
    return `${labels.authLabels.customHeader}${suffix}`.trim();
  }
  if (auth.type === 'session-cookie') {
    return labels.authLabels.sessionCookie;
  }
  return labels.authLabels.none;
}

function buildProfileSnippets(
  profile: ListedProfileDetails,
  labels: ProfileIndexI18n
): { snippets: ProfileIndexSnippet[]; authTabs: ProfileIndexTab[]; modeTabs: ProfileIndexTab[] } {
  const authMethods: RenderAuthMethod[] = profile.authMethods && profile.authMethods.length > 0
    ? profile.authMethods
    : [{ type: 'none' }];

  const snippets: ProfileIndexSnippetDraft[] = [];
  const authTabs: ProfileIndexTab[] = [];

  for (const auth of authMethods) {
    const authLabel = buildAuthLabel(auth, labels);
    const suffix = authLabel ? ` - ${authLabel}` : '';
    const authKey = auth.type;
    authTabs.push({ key: authKey, label: authLabel || auth.type });
    const localSnippetContext = buildLocalConnectionSnippets(profile, auth);

    if (auth.type !== 'session-cookie') {
      const remoteSnippetContext = buildConnectionSnippets(auth);

      snippets.push({
        key: `vscode-${auth.type}`,
        label: `${labels.snippetLabels.vscode}${suffix}`,
        content: remoteSnippetContext.vscode,
        authKey,
        mode: 'remote',
        format: 'json',
      });
      snippets.push({
        key: `cursor-${auth.type}`,
        label: `${labels.snippetLabels.cursor}${suffix}`,
        content: remoteSnippetContext.cursor,
        authKey,
        mode: 'remote',
        format: 'json',
      });
      snippets.push({
        key: `jetbrains-${auth.type}`,
        label: `${labels.snippetLabels.jetbrains}${suffix}`,
        content: remoteSnippetContext.jetbrains,
        authKey,
        mode: 'remote',
        format: 'json',
      });
      snippets.push({
        key: `claude-json-${auth.type}`,
        label: `${labels.snippetLabels.claude}${suffix}`,
        content: remoteSnippetContext.claudeJson,
        authKey,
        mode: 'remote',
        format: 'json',
      });
      snippets.push({
        key: `claude-cli-${auth.type}`,
        label: `${labels.snippetLabels.claude}${suffix}`,
        content: remoteSnippetContext.claudeCli,
        authKey,
        mode: 'remote',
        format: 'cli',
      });
      snippets.push({
        key: `gemini-json-${auth.type}`,
        label: `${labels.snippetLabels.gemini}${suffix}`,
        content: remoteSnippetContext.geminiJson,
        authKey,
        mode: 'remote',
        format: 'json',
      });
      snippets.push({
        key: `gemini-cli-${auth.type}`,
        label: `${labels.snippetLabels.gemini}${suffix}`,
        content: remoteSnippetContext.geminiCli,
        authKey,
        mode: 'remote',
        format: 'cli',
      });
      snippets.push({
        key: `codex-toml-${auth.type}`,
        label: `${labels.snippetLabels.codex}${suffix}`,
        content: remoteSnippetContext.codexToml,
        authKey,
        mode: 'remote',
        format: 'toml',
      });
    }

    if (auth.type === 'oauth' || auth.type === 'bearer') {
      const remoteSnippetContext = buildConnectionSnippets(auth);
      snippets.push({
        key: `codex-cli-${auth.type}`,
        label: `${labels.snippetLabels.codex}${suffix}`,
        content: remoteSnippetContext.codexCli,
        authKey,
        mode: 'remote',
        format: 'cli',
      });
    }
    snippets.push({
      key: `vscode-local-${auth.type}`,
      label: `${labels.snippetLabels.vscode}${suffix}`,
      content: localSnippetContext.vscode,
      authKey,
      mode: 'local',
      format: 'json',
    });
    snippets.push({
      key: `cursor-local-${auth.type}`,
      label: `${labels.snippetLabels.cursor}${suffix}`,
      content: localSnippetContext.cursor,
      authKey,
      mode: 'local',
      format: 'json',
    });
    snippets.push({
      key: `jetbrains-local-${auth.type}`,
      label: `${labels.snippetLabels.jetbrains}${suffix}`,
      content: localSnippetContext.jetbrains,
      authKey,
      mode: 'local',
      format: 'json',
    });
    snippets.push({
      key: `claude-local-json-${auth.type}`,
      label: `${labels.snippetLabels.claude}${suffix}`,
      content: localSnippetContext.claudeJson,
      authKey,
      mode: 'local',
      format: 'json',
    });
    snippets.push({
      key: `claude-local-cli-${auth.type}`,
      label: `${labels.snippetLabels.claude}${suffix}`,
      content: localSnippetContext.claudeCli,
      authKey,
      mode: 'local',
      format: 'cli',
    });
    snippets.push({
      key: `gemini-local-json-${auth.type}`,
      label: `${labels.snippetLabels.gemini}${suffix}`,
      content: localSnippetContext.geminiJson,
      authKey,
      mode: 'local',
      format: 'json',
    });
    snippets.push({
      key: `gemini-local-cli-${auth.type}`,
      label: `${labels.snippetLabels.gemini}${suffix}`,
      content: localSnippetContext.geminiCli,
      authKey,
      mode: 'local',
      format: 'cli',
    });
    snippets.push({
      key: `codex-local-toml-${auth.type}`,
      label: `${labels.snippetLabels.codex}${suffix}`,
      content: localSnippetContext.codexToml,
      authKey,
      mode: 'local',
      format: 'toml',
    });
  }

  const modeTabs: ProfileIndexTab[] = [];
  if (snippets.some((snippet) => snippet.mode === 'remote')) {
    modeTabs.push({ key: 'remote', label: labels.snippetLabels.modeRemote });
  }
  if (snippets.some((snippet) => snippet.mode === 'local')) {
    modeTabs.push({ key: 'local', label: labels.snippetLabels.modeLocal });
  }

  return { snippets: snippets.map(applySnippetCapabilities), authTabs, modeTabs };
}

function applySnippetCapabilities(snippet: ProfileIndexSnippetDraft): ProfileIndexSnippet {
  const supportsRemoteCustomHeaders = snippet.mode === 'remote' && (
    snippet.key.startsWith('vscode-') ||
    snippet.key.startsWith('cursor-') ||
    snippet.key.startsWith('jetbrains-') ||
    snippet.key.startsWith('claude-json-') ||
    snippet.key.startsWith('gemini-json-') ||
    snippet.key.startsWith('codex-toml-')
  );

  return {
    ...snippet,
    supportsCustomHeaders: supportsRemoteCustomHeaders,
    supportsTenantHeaders: supportsRemoteCustomHeaders,
  };
}

function buildConnectionSnippets(
  auth: RenderAuthMethod
): {
  vscode: string;
  cursor: string;
  jetbrains: string;
  claudeJson: string;
  claudeCli: string;
  geminiJson: string;
  geminiCli: string;
  codexToml: string;
  codexCli: string;
} {
  const tokenEnv = auth.type === 'none'
    ? undefined
    : auth.valueFromEnv || (auth.type === 'oauth' ? undefined : 'MCP4_API_TOKEN');
  const inputMap = new Map<string, string>();
  if (tokenEnv && isSensitiveEnvVar(tokenEnv)) {
    const input = buildInputs([tokenEnv])[0];
    inputMap.set(tokenEnv, input.id);
  }

  const headerName = auth.type === 'custom-header'
    ? (auth.headerName || 'X-API-Token')
    : 'Authorization';
  const queryParam = auth.type === 'query' ? (auth.queryParam || 'api_key') : undefined;

  const vscodeToken = tokenEnv
    ? buildEnvValue(tokenEnv, inputMap, isSensitiveEnvVar(tokenEnv), 'vscode')
    : '<token>';
  const cursorToken = tokenEnv
    ? `\${env:${tokenEnv}}`
    : '<token>';
  const jetbrainsToken = tokenEnv
    ? buildEnvValue(tokenEnv, inputMap, isSensitiveEnvVar(tokenEnv), 'jetbrains')
    : '<token>';
  const cliToken = tokenEnv
    ? buildEnvValue(tokenEnv, inputMap, false, 'cli')
    : '<token>';

  const vscodeHeaderValue = auth.type === 'bearer' ? `Bearer ${vscodeToken}` : vscodeToken;
  const cursorHeaderValue = auth.type === 'bearer' ? `Bearer ${cursorToken}` : cursorToken;
  const jetbrainsHeaderValue = auth.type === 'bearer' ? `Bearer ${jetbrainsToken}` : jetbrainsToken;
  const cliHeaderValue = auth.type === 'bearer' ? `Bearer ${cliToken}` : cliToken;

  const headersBlock = auth.type === 'oauth' || auth.type === 'none' || auth.type === 'query'
    ? []
    : [
        '      "headers": {',
        `        "${headerName}": "${vscodeHeaderValue}"`,
        '      }',
      ];

  const vscodeUrl = auth.type === 'query'
    ? `__PROFILE_URL__?${queryParam}=${vscodeToken}`
    : '__PROFILE_URL__';
  const cursorUrl = auth.type === 'query'
    ? `__PROFILE_URL__?${queryParam}=${cursorToken}`
    : '__PROFILE_URL__';
  const jetbrainsUrl = auth.type === 'query'
    ? `__PROFILE_URL__?${queryParam}=${jetbrainsToken}`
    : '__PROFILE_URL__';
  const claudeUrl = auth.type === 'query'
    ? `__PROFILE_URL__?${queryParam}=${cliToken}`
    : '__PROFILE_URL__';

  const vscodeLines: string[] = [
    '{',
    '  "servers": {',
    '    "__PROFILE_ID__": {',
    '      "type": "http",',
    `      "url": "${vscodeUrl}"`,
  ];
  if (headersBlock.length > 0) {
    appendComma(vscodeLines);
    vscodeLines.push(...headersBlock);
  }
  vscodeLines.push('    }', '  }');
  if (tokenEnv && inputMap.has(tokenEnv)) {
    const inputsBlock = buildInputsBlock([{ id: inputMap.get(tokenEnv)!, description: tokenEnv }], '  ');
    if (inputsBlock.length > 0) {
      appendComma(vscodeLines);
      vscodeLines.push(...inputsBlock);
    }
  }
  vscodeLines.push('}');

  const cursorLines: string[] = [
    '{',
    '  "mcpServers": {',
    '    "__PROFILE_ID__": {',
    '      "type": "http",',
    `      "url": "${cursorUrl}"`,
  ];
  if (headersBlock.length > 0) {
    appendComma(cursorLines);
    cursorLines.push('      "headers": {');
    cursorLines.push(`        "${headerName}": "${cursorHeaderValue}"`);
    cursorLines.push('      }');
  }
  cursorLines.push('    }', '  }', '}');

  const jetbrainsLines: string[] = [
    '{',
    '  "servers": {',
    '    "__PROFILE_ID__": {',
    '      "type": "http",',
    `      "url": "${jetbrainsUrl}"`,
  ];
  if (headersBlock.length > 0) {
    appendComma(jetbrainsLines);
    jetbrainsLines.push('      "requestInit": {');
    jetbrainsLines.push('        "headers": {');
    jetbrainsLines.push(`          "${headerName}": "${jetbrainsHeaderValue}"`);
    jetbrainsLines.push('        }');
    jetbrainsLines.push('      }');
  }
  jetbrainsLines.push('    }', '  }', '}');

  return {
    vscode: vscodeLines.join('\n'),
    cursor: cursorLines.join('\n'),
    jetbrains: jetbrainsLines.join('\n'),
    claudeJson: buildClaudeJsonSnippet(auth, headerName, cliHeaderValue, claudeUrl),
    claudeCli: buildClaudeSnippet(auth, headerName, cliHeaderValue, claudeUrl),
    geminiJson: buildGeminiRemoteJsonSnippet(auth, headerName, cliHeaderValue, claudeUrl),
    geminiCli: buildGeminiRemoteCliSnippet(auth, headerName, cliHeaderValue, claudeUrl),
    codexToml: buildCodexRemoteTomlSnippet(auth, headerName, cliHeaderValue, claudeUrl, tokenEnv),
    codexCli: buildCodexRemoteCliSnippet(auth, headerName, cliHeaderValue, claudeUrl, tokenEnv),
  };
}

function buildLocalConnectionSnippets(
  profile: ListedProfileDetails,
  auth: RenderAuthMethod
): {
  vscode: string;
  cursor: string;
  jetbrains: string;
  claudeJson: string;
  claudeCli: string;
  geminiJson: string;
  geminiCli: string;
  codexToml: string;
  codexCli: string;
} {
  const localEnvVarNames = resolveLocalEnvVarNames(profile, auth);
  const sensitiveEnvVars = localEnvVarNames.filter(isSensitiveEnvVar);
  const inputMap = new Map<string, string>();
  if (sensitiveEnvVars.length > 0) {
    const inputDefs = buildInputs(sensitiveEnvVars);
    for (let index = 0; index < sensitiveEnvVars.length; index += 1) {
      const envVarName = sensitiveEnvVars[index];
      const inputDef = inputDefs[index];
      if (inputDef) {
        inputMap.set(envVarName, inputDef.id);
      }
    }
  }

  const args = ['-y', 'mcp4openapi', '--profile', '__PROFILE_ID__'];
  const localApiBaseEnv = resolveLocalApiBaseEnv(profile);
  const vscodeEnv = buildLocalEnvMap(profile, localEnvVarNames, inputMap, 'vscode');
  const cursorEnv = buildLocalEnvMap(profile, localEnvVarNames, inputMap, 'cursor');
  const jetbrainsEnv = buildLocalEnvMap(profile, localEnvVarNames, inputMap, 'jetbrains');
  const claudeEnv = buildLocalEnvMap(profile, localEnvVarNames, inputMap, 'cli');

  const vscodeServer: Record<string, unknown> = {
    type: 'stdio',
    command: 'npx',
    args,
  };
  if (Object.keys(vscodeEnv).length > 0) {
    vscodeServer.env = vscodeEnv;
  }

  const vscodeConfig: Record<string, unknown> = {
    servers: {
      __PROFILE_ID__: vscodeServer,
    },
  };
  if (sensitiveEnvVars.length > 0) {
    vscodeConfig.inputs = buildInputs(sensitiveEnvVars).map(input => ({
      type: 'promptString',
      id: input.id,
      description: input.description,
      password: true,
    }));
  }

  const cursorConfig = {
    mcpServers: {
      __PROFILE_ID__: {
        command: 'npx',
        args,
        ...(Object.keys(cursorEnv).length > 0 ? { env: cursorEnv } : {}),
      },
    },
  };

  const jetbrainsConfig = {
    servers: {
      __PROFILE_ID__: {
        type: 'stdio',
        command: 'npx',
        args,
        ...(Object.keys(jetbrainsEnv).length > 0 ? { env: jetbrainsEnv } : {}),
      },
    },
  };

  const claudeJsonConfig = {
    mcpServers: {
      __PROFILE_ID__: {
        command: 'npx',
        args,
        ...(Object.keys(claudeEnv).length > 0 ? { env: claudeEnv } : {}),
      },
    },
  };

  return {
    vscode: JSON.stringify(vscodeConfig, null, 2),
    cursor: JSON.stringify(cursorConfig, null, 2),
    jetbrains: JSON.stringify(jetbrainsConfig, null, 2),
    claudeJson: JSON.stringify(claudeJsonConfig, null, 2),
    claudeCli: buildLocalClaudeSnippet(profile, localApiBaseEnv),
    geminiJson: buildLocalGeminiJsonSnippet(args, localApiBaseEnv),
    geminiCli: buildLocalGeminiSnippet(profile, localApiBaseEnv),
    codexToml: buildCodexLocalTomlSnippet(localEnvVarNames, claudeEnv),
    codexCli: buildLocalCodexSnippet(localEnvVarNames, claudeEnv),
  };
}

function buildLocalEnvMap(
  profile: ListedProfileDetails,
  envVarNames: string[],
  inputMap: Map<string, string>,
  mode: 'vscode' | 'cursor' | 'jetbrains' | 'cli'
): Record<string, string> {
  const envMap: Record<string, string> = {};
  const { envVar: baseUrlVar, envValue: baseUrlEnvValue, defaultValue: baseUrlDefault } = resolveConfiguredApiBaseUrl(profile);
  const resolvedBaseUrlValue = baseUrlEnvValue || baseUrlDefault;

  for (const envVar of envVarNames) {
    if (baseUrlVar && envVar === baseUrlVar && resolvedBaseUrlValue) {
      envMap[envVar] = resolvedBaseUrlValue;
      continue;
    }
    envMap[envVar] = buildEnvValue(envVar, inputMap, isSensitiveEnvVar(envVar), mode);
  }

  return envMap;
}

function resolveLocalApiBaseEnv(profile: ListedProfileDetails): { envVar: string; value: string } | null {
  const { envVar, envValue, defaultValue } = resolveConfiguredApiBaseUrl(profile);
  if (!envVar) {
    return null;
  }
  return {
    envVar,
    value: envValue || defaultValue || `\${${envVar}}`,
  };
}

function buildLocalClaudeSnippet(
  profile: ListedProfileDetails,
  localApiBaseEnv: { envVar: string; value: string } | null
): string {
  void profile;
  const parts = ['claude', 'mcp', 'add', '-s', 'user'];
  if (localApiBaseEnv) {
    parts.push('--env', `"${localApiBaseEnv.envVar}=${localApiBaseEnv.value}"`);
  }
  parts.push('__PROFILE_ID__', '--', 'npx', '-y', 'mcp4openapi', '--profile', '__PROFILE_ID__');
  return parts.join(' ');
}

function buildLocalGeminiSnippet(
  profile: ListedProfileDetails,
  localApiBaseEnv: { envVar: string; value: string } | null
): string {
  void profile;
  const parts = ['gemini', 'mcp', 'add', '-s', 'user'];
  if (localApiBaseEnv) {
    parts.push('-e', `"${localApiBaseEnv.envVar}=${localApiBaseEnv.value}"`);
  }
  parts.push('__PROFILE_ID__', '--', 'npx', '-y', 'mcp4openapi', '--profile', '__PROFILE_ID__');
  return parts.join(' ');
}

function buildLocalCodexSnippet(envVarNames: string[], envMap: Record<string, string>): string {
  const parts = ['codex mcp add __PROFILE_ID__'];
  for (const envVar of envVarNames) {
    const value = envMap[envVar];
    if (!value) continue;
    parts.push(`--env "${envVar}=${value}"`);
  }
  parts.push('-- npx -y mcp4openapi --profile __PROFILE_ID__');
  return parts.join(' ');
}

function buildLocalGeminiJsonSnippet(
  args: string[],
  localApiBaseEnv: { envVar: string; value: string } | null
): string {
  const server: Record<string, unknown> = {
    command: 'npx',
    args,
  };
  if (localApiBaseEnv) {
    server.env = {
      [localApiBaseEnv.envVar]: localApiBaseEnv.value,
    };
  }
  const config = {
    mcpServers: {
      __PROFILE_ID__: server,
    },
  };
  return JSON.stringify(config, null, 2);
}

function buildCodexRemoteCliSnippet(
  auth: RenderAuthMethod,
  headerName: string,
  headerValue: string,
  url: string,
  tokenEnv?: string
): string {
  const lines: string[] = [];
  const baseParts = ['codex mcp add', '--url', `"${url}"`];
  if (auth.type === 'bearer' && tokenEnv) {
    baseParts.push('--bearer-token-env-var', tokenEnv);
  }
  baseParts.push('__PROFILE_ID__');
  const base = baseParts.join(' ');
  if (auth.type !== 'oauth' && auth.type !== 'none' && auth.type !== 'query' && auth.type !== 'bearer') {
    lines.push(`${base} --header "${headerName}: ${headerValue}"`);
  } else {
    lines.push(base);
  }
  return lines.join('\n');
}

function buildCodexRemoteTomlSnippet(
  auth: RenderAuthMethod,
  headerName: string,
  headerValue: string,
  url: string,
  tokenEnv?: string
): string {
  const includeEnvVars = Boolean(tokenEnv) && auth.type !== 'bearer';
  const envVars = includeEnvVars && tokenEnv ? [tokenEnv] : [];
  const lines: string[] = [
    '[mcp_servers.__PROFILE_ID__]',
    'transport = "http"',
    `url = "${url}"`,
  ];
  if (envVars.length > 0) {
    lines.push(`env_vars = ${formatTomlArray(envVars)}`);
  }
  if (auth.type === 'bearer' && tokenEnv) {
    lines.push(`bearer_token_env_var = "${tokenEnv}"`);
  } else if (auth.type !== 'oauth' && auth.type !== 'none' && auth.type !== 'query') {
    lines.push('');
    lines.push(`http_headers = { "${headerName}" = "${headerValue}" }`);
  }
  return lines.join('\n');
}

function buildCodexLocalTomlSnippet(
  envVarNames: string[],
  envMap: Record<string, string>
): string {
  const args = ['-y', 'mcp4openapi', '--profile', '__PROFILE_ID__'];
  const envVars = envVarNames.filter(envVar => {
    const value = envMap[envVar];
    return value === `\${${envVar}}`;
  });
  const envVarSet = new Set(envVars);
  const lines: string[] = [
    '[mcp_servers.__PROFILE_ID__]',
    'command = "npx"',
    `args = ${formatTomlArray(args)}`,
  ];
  if (envVars.length > 0) {
    lines.push(`env_vars = ${formatTomlArray(envVars)}`);
  }
  const explicitEnvEntries: string[] = [];
  for (const envVar of envVarNames) {
    if (envVarSet.has(envVar)) {
      continue;
    }
    const value = envMap[envVar];
    if (!value) continue;
    explicitEnvEntries.push(`${envVar} = "${value}"`);
  }
  if (explicitEnvEntries.length > 0) {
    lines.push('');
    lines.push('[mcp_servers.__PROFILE_ID__.env]');
    lines.push(...explicitEnvEntries);
  }
  return lines.join('\n');
}

function resolveLocalEnvVarNames(profile: ListedProfileDetails, auth: RenderAuthMethod): string[] {
  const oauthOnly = new Set(profile.oauthEnvVars || []);
  const baseUrlEnv = profile.apiBaseUrl?.valueFromEnv;
  const authEnvVars = new Set<string>();

  if (auth.type === 'bearer' || auth.type === 'query' || auth.type === 'custom-header') {
    if (auth.valueFromEnv) {
      authEnvVars.add(auth.valueFromEnv);
    }
  } else if (auth.type === 'session-cookie') {
    if (auth.usernameFromEnv) {
      authEnvVars.add(auth.usernameFromEnv);
    }
    if (auth.passwordFromEnv) {
      authEnvVars.add(auth.passwordFromEnv);
    }
  }

  if (baseUrlEnv) {
    authEnvVars.add(baseUrlEnv);
  }

  if (authEnvVars.size === 0) {
    return profile.envVars.filter(envVar => !oauthOnly.has(envVar));
  }

  return profile.envVars.filter(envVar => !oauthOnly.has(envVar) && authEnvVars.has(envVar));
}

function formatTomlArray(values: string[]): string {
  const quoted = values.map(value => `"${value}"`);
  return `[${quoted.join(', ')}]`;
}

function buildInputsBlock(inputs: Array<{ id: string; description: string }>, indent: string): string[] {
  if (inputs.length === 0) {
    return [];
  }
  const lines: string[] = [];
  lines.push(`${indent}"inputs": [`);
  inputs.forEach((input, index) => {
    const suffix = index === inputs.length - 1 ? '' : ',';
    lines.push(`${indent}  {`);
    lines.push(`${indent}    "type": "promptString",`);
    lines.push(`${indent}    "id": "${input.id}",`);
    lines.push(`${indent}    "description": "${input.description}",`);
    lines.push(`${indent}    "password": true`);
    lines.push(`${indent}  }${suffix}`);
  });
  lines.push(`${indent}]`);
  return lines;
}

function buildClaudeSnippet(
  auth: RenderAuthMethod,
  headerName: string,
  headerValue: string,
  url: string
): string {
  const lines: string[] = [];
  const escapedUrl = escapeEnvExpansionForCli(url);
  const escapedHeaderValue = escapeEnvExpansionForCli(headerValue);
  const base = `claude mcp add -s user __PROFILE_ID__ --transport http ${escapedUrl}`;
  if (auth.type !== 'oauth' && auth.type !== 'none' && auth.type !== 'query') {
    lines.push(`${base} \\\n  --header \"${headerName}: ${escapedHeaderValue}\"`);
  } else {
    lines.push(base);
  }
  return lines.join('\n');
}

function buildGeminiRemoteCliSnippet(
  auth: RenderAuthMethod,
  headerName: string,
  headerValue: string,
  url: string
): string {
  const escapedUrl = escapeEnvExpansionForCli(url);
  const escapedHeaderValue = escapeEnvExpansionForCli(headerValue);
  const base = `gemini mcp add -s user --transport http __PROFILE_ID__ ${escapedUrl}`;
  if (auth.type !== 'oauth' && auth.type !== 'none' && auth.type !== 'query') {
    return `${base} \\\n  --header "${headerName}: ${escapedHeaderValue}"`;
  }
  return base;
}

function escapeEnvExpansionForCli(value: string): string {
  return value.replace(/\$\{/g, '\\${');
}

function buildClaudeJsonSnippet(
  auth: RenderAuthMethod,
  headerName: string,
  headerValue: string,
  url: string
): string {
  const lines: string[] = [
    '{',
    '  "mcpServers": {',
    '    "__PROFILE_ID__": {',
    '      "type": "http",',
    `      "url": "${url}"`,
  ];
  if (auth.type !== 'oauth' && auth.type !== 'none' && auth.type !== 'query') {
    appendComma(lines);
    lines.push('      "headers": {');
    lines.push(`        "${headerName}": "${headerValue}"`);
    lines.push('      }');
  }
  lines.push('    }', '  }', '}');
  return lines.join('\n');
}

function buildGeminiRemoteJsonSnippet(
  auth: RenderAuthMethod,
  headerName: string,
  headerValue: string,
  url: string
): string {
  const lines: string[] = [
    '{',
    '  "mcpServers": {',
    '    "__PROFILE_ID__": {',
    `      "httpUrl": "${url}"`,
  ];
  if (auth.type !== 'oauth' && auth.type !== 'none' && auth.type !== 'query') {
    appendComma(lines);
    lines.push('      "headers": {');
    lines.push(`        "${headerName}": "${headerValue}"`);
    lines.push('      }');
  }
  lines.push('    }', '  }', '}');
  return lines.join('\n');
}

export const __test__ = {
  buildInputs,
  buildInputsBlock,
  buildEnvValue,
  buildProfileIndexI18n,
  resolveApiEndpoint,
  renderTemplate,
  safeJsonForHtml,
};
