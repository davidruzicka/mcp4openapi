import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtmlSafe } from '../validation/validation-utils.js';
import type { ListedProfileDetails, ProfileAuthMethod } from '../profile/profile-resolver.js';

export type ProfileIndexLocale = 'cs' | 'en';

interface ProfileIndexI18n {
  title: string;
  subtitle: string;
  noscript: string;
  profileLabel: string;
  endpointLabel: string;
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
    jetbrains: string;
  };
  authLabels: {
    oauth: string;
    bearer: string;
    query: string;
    customHeader: string;
    none: string;
  };
  authHeaderPrefix: string;
  authQueryPrefix: string;
}

interface ProfileIndexSnippet {
  key: string;
  label: string;
  content: string;
  authKey: string;
  format: 'json' | 'cli';
}

interface ProfileIndexTab {
  key: string;
  label: string;
}

type RenderAuthMethod = ProfileAuthMethod | { type: 'none' };

interface ProfileIndexProfile extends ListedProfileDetails {
  mcpUrl: string;
  sseUrl: string;
  snippets: ProfileIndexSnippet[];
  authTabs: ProfileIndexTab[];
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
  let current = moduleDir;
  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const templatePath = path.join(current, 'html', 'profile-index.html');
  const template = await fs.promises.readFile(templatePath, 'utf-8');
  cachedTemplate = template;
  return template;
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
        jetbrains: 'JetBrains IDEs + Copilot',
      },
      authLabels: {
        oauth: 'OAuth',
        bearer: 'Bearer',
        query: 'Token (query)',
        customHeader: 'Vlastní hlavička',
        none: 'Bez autentizace',
      },
      authHeaderPrefix: 'Hlavička',
      authQueryPrefix: 'Parametr',
    };
  }

  return {
    title: 'MCP profiles',
    subtitle: 'Available MCP profiles and quick connection guides.',
    noscript: 'Enable JavaScript to view the instructions.',
    profileLabel: 'Profile',
    endpointLabel: 'Endpoints',
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
      jetbrains: 'JetBrains IDEs + Copilot',
    },
    authLabels: {
      oauth: 'OAuth',
      bearer: 'Bearer',
      query: 'Token (query)',
      customHeader: 'Custom header',
      none: 'No auth',
    },
    authHeaderPrefix: 'Header',
    authQueryPrefix: 'Query param',
  };
}

export function buildProfileIndexPayload(
  profiles: ListedProfileDetails[],
  origin: string,
  locale: ProfileIndexLocale
): { payload: ProfileIndexPayload; templateData: Record<string, string> } {
  const i18n = buildProfileIndexI18n(locale);
  const enriched = profiles.map(profile => {
    const { snippets, authTabs } = buildProfileSnippets(profile, i18n);
    return {
      ...profile,
      mcpUrl: `${origin}/profile/${encodeURIComponent(profile.profileId)}/mcp`,
      sseUrl: `${origin}/profile/${encodeURIComponent(profile.profileId)}/sse`,
      snippets,
      authTabs,
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
  if (useInput) {
    const id = inputMap.get(name);
    if (id) {
      if (mode === 'jetbrains') {
        return `{$input:${id}}`;
      }
      return `\${input:${id}}`;
    }
  }
  if (mode === 'cursor') {
    return `\${env:${name}}`;
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
  return labels.authLabels.none;
}

function buildProfileSnippets(profile: ListedProfileDetails, labels: ProfileIndexI18n): { snippets: ProfileIndexSnippet[]; authTabs: ProfileIndexTab[] } {
  const authMethods: RenderAuthMethod[] = profile.authMethods && profile.authMethods.length > 0
    ? profile.authMethods
    : [{ type: 'none' }];

  const snippets: ProfileIndexSnippet[] = [];
  const authTabs: ProfileIndexTab[] = [];

  for (const auth of authMethods) {
    const authLabel = buildAuthLabel(auth, labels);
    const suffix = authLabel ? ` - ${authLabel}` : '';
    const authKey = auth.type;
    authTabs.push({ key: authKey, label: authLabel || auth.type });
    const snippetContext = buildConnectionSnippets(auth, labels);

    snippets.push({
      key: `vscode-${auth.type}`,
      label: `${labels.snippetLabels.vscode}${suffix}`,
      content: snippetContext.vscode,
      authKey,
      format: 'json',
    });
    snippets.push({
      key: `cursor-${auth.type}`,
      label: `${labels.snippetLabels.cursor}${suffix}`,
      content: snippetContext.cursor,
      authKey,
      format: 'json',
    });
    snippets.push({
      key: `jetbrains-${auth.type}`,
      label: `${labels.snippetLabels.jetbrains}${suffix}`,
      content: snippetContext.jetbrains,
      authKey,
      format: 'json',
    });
    snippets.push({
      key: `claude-${auth.type}`,
      label: `${labels.snippetLabels.claude}${suffix}`,
      content: snippetContext.claude,
      authKey,
      format: 'cli',
    });
  }

  return { snippets, authTabs };
}

function buildConnectionSnippets(
  auth: RenderAuthMethod,
  labels: ProfileIndexI18n
): { vscode: string; cursor: string; jetbrains: string; claude: string } {
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
    ? buildEnvValue(tokenEnv, inputMap, false, 'cursor')
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
  ];
  if (auth.type === 'query') {
    cursorLines.push('      "type": "http",');
    cursorLines.push(`      "url": "${cursorUrl}"`);
  } else if (headersBlock.length > 0) {
    cursorLines.push('      "command": "npx",');
    cursorLines.push('      "args": [');
    cursorLines.push('        "-y",');
    cursorLines.push('        "mcp-remote",');
    cursorLines.push(`        "${cursorUrl}",`);
    cursorLines.push('        "--header",');
    cursorLines.push(`        "${headerName}: ${cursorHeaderValue}"`);
    cursorLines.push('      ],');
    if (tokenEnv) {
      cursorLines.push('      "env": {');
      cursorLines.push(`        "${tokenEnv}": "${buildEnvValue(tokenEnv, inputMap, false, 'cursor')}"`);
      cursorLines.push('      }');
    }
  } else {
    cursorLines.push('      "type": "http",');
    cursorLines.push('      "url": "__PROFILE_URL__"');
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
    claude: buildClaudeSnippet(auth, headerName, cliHeaderValue, claudeUrl),
  };
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
  const base = `claude mcp add __PROFILE_ID__ --transport http ${url}`;
  if (auth.type !== 'oauth' && auth.type !== 'none' && auth.type !== 'query') {
    lines.push(`${base} \\\n  --header \"${headerName}: ${headerValue}\"`);
  } else {
    lines.push(base);
  }
  return lines.join('\n');
}
