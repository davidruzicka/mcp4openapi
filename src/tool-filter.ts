import type { ToolDefinition } from './types/profile.js';
import type { OperationInfo } from './types/openapi.js';
import { ConfigurationError, ValidationError } from './errors.js';

const MAX_REGEX_LENGTH = 100;
const MAX_HEADER_ENTRY_LENGTH = 255;
const DEFAULT_MAX_SESSION_ENTRIES = 100;

export interface ToolFilterConfig {
  allowList: Set<string>;
  denyList: Set<string>;
  allowRegex: RegExp[];
  denyRegex: RegExp[];
  allowComposite: { allowList: boolean; allowRead: boolean };
  hasAllowRules: boolean;
  sources: {
    allowList: string[];
    allowRegex: string[];
    denyList: string[];
    denyRegex: string[];
    allowComposite: string[];
  };
}

export interface ToolFilterResult {
  allowed: ToolDefinition[];
  removed: ToolDefinition[];
  reasons: Map<string, string[]>;
}

export interface SessionToolFilterRequest {
  exactNames: Set<string>;
  regexPatterns: RegExp[];
  allowComposite: { allowList: boolean; allowRead: boolean };
  normalizedHeader: string;
  rawEntries: string[];
  hasRules: boolean;
}

export interface SessionToolFilter {
  allowedToolNames: Set<string>;
  reasons: Map<string, string[]>;
  patterns: { allow: RegExp[] };
  allowComposite: { allowList: boolean; allowRead: boolean };
  normalizedHeader: string;
}

export interface ToolFilterOperationResolver {
  getOperationById?: (operationId: string) => OperationInfo | undefined;
  getOperationForCall?: (call: string) => OperationInfo | undefined;
}

export function normalizeToolName(name: string): string {
  return name.normalize('NFC');
}

export function normalizeToolFilterHeaderValue(value?: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseToolFilterConfig(env: NodeJS.ProcessEnv): ToolFilterConfig | undefined {
  const allowListRaw = env.MCP4_TOOL_FILTER_ALLOW_LIST;
  const allowRegexRaw = env.MCP4_TOOL_FILTER_ALLOW_REGEX;
  const denyListRaw = env.MCP4_TOOL_FILTER_DENY_LIST;
  const denyRegexRaw = env.MCP4_TOOL_FILTER_DENY_REGEX;
  const allowCompositeRaw = env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES;

  const hasAnyEnv =
    allowListRaw !== undefined ||
    allowRegexRaw !== undefined ||
    denyListRaw !== undefined ||
    denyRegexRaw !== undefined ||
    allowCompositeRaw !== undefined;

  if (!hasAnyEnv) {
    return undefined;
  }

  const allowListEntries = parseCsvList(allowListRaw);
  const denyListEntries = parseCsvList(denyListRaw);
  const allowRegexEntries = parseCsvList(allowRegexRaw);
  const denyRegexEntries = parseCsvList(denyRegexRaw);
  const allowCompositeEntries = parseCsvList(allowCompositeRaw);

  const allowList = new Set(allowListEntries.map(normalizeToolName));
  const denyList = new Set(denyListEntries.map(normalizeToolName));
  const allowRegex = allowRegexEntries.map(pattern =>
    compileRegex(pattern, 'MCP4_TOOL_FILTER_ALLOW_REGEX', ConfigurationError)
  );
  const denyRegex = denyRegexEntries.map(pattern =>
    compileRegex(pattern, 'MCP4_TOOL_FILTER_DENY_REGEX', ConfigurationError)
  );

  const allowComposite = parseAllowCompositeEntries(
    allowCompositeEntries,
    'MCP4_TOOL_FILTER_ALLOW_COMPOSITES',
    ConfigurationError
  );

  return {
    allowList,
    denyList,
    allowRegex,
    denyRegex,
    allowComposite,
    hasAllowRules:
      allowListEntries.length > 0 ||
      allowRegexEntries.length > 0 ||
      allowComposite.allowList ||
      allowComposite.allowRead,
    sources: {
      allowList: allowListEntries,
      allowRegex: allowRegexEntries,
      denyList: denyListEntries,
      denyRegex: denyRegexEntries,
      allowComposite: allowCompositeEntries,
    },
  };
}

export function parseSessionToolFilterHeader(
  headerValue: string,
  maxEntries: number = getSessionToolFilterMaxEntries()
): SessionToolFilterRequest {
  const normalizedHeader = normalizeToolFilterHeaderValue(headerValue) ?? '';
  if (!normalizedHeader) {
    return {
      exactNames: new Set(),
      regexPatterns: [],
      allowComposite: { allowList: false, allowRead: false },
      normalizedHeader: '',
      rawEntries: [],
      hasRules: false,
    };
  }

  const parts = normalizedHeader.split(',').map(part => part.trim()).filter(Boolean);
  if (parts.length > maxEntries) {
    throw new ValidationError(
      `X-Mcp4-Tools contains too many entries (${parts.length} > ${maxEntries}). Reduce to ${maxEntries} or configure MCP4_TOOL_FILTER_SESSION_MAX_TOOLS.`
    );
  }

  const exactNames = new Set<string>();
  const regexPatterns: RegExp[] = [];
  const rawEntries: string[] = [];
  const allowCompositeEntries: string[] = [];

  for (const entry of parts) {
    if (entry.length > MAX_HEADER_ENTRY_LENGTH) {
      throw new ValidationError(
        `X-Mcp4-Tools entry exceeds 255 chars: '${entry}' (${entry.length} chars).`
      );
    }

    rawEntries.push(entry);

    if (entry === '_allow_list' || entry === '_allow_read') {
      allowCompositeEntries.push(entry);
      continue;
    }
    if (entry.startsWith('_allow_')) {
      throw new ValidationError('X-Mcp4-Tools supports only _allow_list or _allow_read.');
    }

    if (entry.startsWith('regex:')) {
      const rawPattern = entry.slice('regex:'.length).trim();
      if (!rawPattern) {
        throw new ValidationError('X-Mcp4-Tools regex entry is empty.');
      }
      regexPatterns.push(compileRegex(rawPattern, 'X-Mcp4-Tools', ValidationError));
      continue;
    }

    exactNames.add(normalizeToolName(entry));
  }

  const allowComposite = parseAllowCompositeEntries(allowCompositeEntries, 'X-Mcp4-Tools', ValidationError);
  const normalizedEntries = buildNormalizedSessionEntries({
    exactNames,
    regexPatterns,
    allowComposite,
  });

  return {
    exactNames,
    regexPatterns,
    allowComposite,
    normalizedHeader: normalizedEntries.join(', '),
    rawEntries,
    hasRules: exactNames.size > 0 || regexPatterns.length > 0 || allowComposite.allowList || allowComposite.allowRead,
  };
}

export function applyToolFilter(
  tools: ToolDefinition[],
  config: ToolFilterConfig,
  resolver?: ToolFilterOperationResolver
): ToolFilterResult {
  const reasons = new Map<string, string[]>();
  const allowed: ToolDefinition[] = [];
  const removed: ToolDefinition[] = [];

  for (const tool of tools) {
    const normalizedName = normalizeToolName(tool.name);
    const denyReasons: string[] = [];

    if (config.denyList.has(normalizedName)) {
      denyReasons.push(`deny_list:${normalizedName}`);
    }
    for (const regex of config.denyRegex) {
      if (regex.test(normalizedName)) {
        denyReasons.push(`deny_regex:${regex.source}`);
      }
    }

    if (denyReasons.length > 0) {
      reasons.set(tool.name, denyReasons);
      removed.push(tool);
      continue;
    }

    if (config.hasAllowRules) {
      const allowReasons = getAllowMatchReasons(tool, normalizedName, config, resolver);
      if (allowReasons.length === 0) {
        reasons.set(tool.name, getAllowFailureReasons(config));
        removed.push(tool);
        continue;
      }
    }

    allowed.push(tool);
  }

  return { allowed, removed, reasons };
}

export function applySessionToolFilter(
  tools: ToolDefinition[],
  request: SessionToolFilterRequest,
  resolver?: ToolFilterOperationResolver
): SessionToolFilter {
  const reasons = new Map<string, string[]>();
  const allowedToolNames = new Set<string>();

  for (const tool of tools) {
    const normalizedName = normalizeToolName(tool.name);
    const allowReasons = getSessionAllowReasons(tool, normalizedName, request, resolver);

    if (!request.hasRules || allowReasons.length > 0) {
      allowedToolNames.add(tool.name);
      continue;
    }

    reasons.set(tool.name, [`session_allow_list:${request.normalizedHeader || 'none'}`]);
  }

  return {
    allowedToolNames,
    reasons,
    patterns: { allow: request.regexPatterns },
    allowComposite: request.allowComposite,
    normalizedHeader: request.normalizedHeader,
  };
}

export function detectListReadOperations(
  tool: ToolDefinition,
  resolver?: ToolFilterOperationResolver
): { isList: boolean; isRead: boolean } {
  let isList = false;
  let isRead = false;

  if (tool.composite && tool.steps && resolver?.getOperationForCall) {
    for (const step of tool.steps) {
      const operation = resolver.getOperationForCall(step.call);
      if (operation) {
        const category = resolveOperationCategory(operation);
        if (category === 'list') {
          isList = true;
        }
        if (category === 'read') {
          isRead = true;
        }
      }
    }
  } else if (tool.operations) {
    for (const [action, operationId] of Object.entries(tool.operations)) {
      if (typeof operationId === 'string' && resolver?.getOperationById) {
        const operation = resolver.getOperationById(operationId);
        if (operation) {
          const category = resolveOperationCategory(operation);
          if (category === 'list') {
            isList = true;
          }
          if (category === 'read') {
            isRead = true;
          }
          continue;
        }
      }

      const actionValue = action.toLowerCase();
      if (actionValue === 'list' || actionValue === 'search') {
        isList = true;
      }
      if (actionValue === 'get' || actionValue === 'read') {
        isRead = true;
      }
    }
  }

  return { isList, isRead };
}

export function validateRegexPattern(pattern: string): { valid: boolean; error?: string } {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return {
      valid: false,
      error: `Regex pattern exceeds ${MAX_REGEX_LENGTH} characters.`,
    };
  }

  if (hasNestedQuantifiers(pattern)) {
    return {
      valid: false,
      error: 'Regex pattern contains nested quantifiers.',
    };
  }

  return { valid: true };
}

export function getSessionToolFilterMaxEntries(): number {
  const raw = process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS;
  if (raw === undefined) {
    return DEFAULT_MAX_SESSION_ENTRIES;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ConfigurationError(
      `Invalid MCP4_TOOL_FILTER_SESSION_MAX_TOOLS: expected positive integer, got '${raw}'.`
    );
  }
  return parsed;
}

function parseCsvList(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

function compileRegex(
  pattern: string,
  context: string,
  ErrorType: new (message: string) => Error
): RegExp {
  const trimmed = pattern.trim();
  const anchored = autoAnchorPattern(trimmed);
  const validation = validateRegexPattern(anchored);
  if (!validation.valid) {
    throw new ErrorType(`${context} regex '${pattern}' is invalid: ${validation.error}`);
  }
  try {
    return new RegExp(anchored);
  } catch (error) {
    throw new ErrorType(`${context} regex '${pattern}' is invalid: ${(error as Error).message}`);
  }
}

function autoAnchorPattern(pattern: string): string {
  const anchoredStart = pattern.startsWith('^') ? pattern : `^${pattern}`;
  const anchoredEnd = anchoredStart.endsWith('$') ? anchoredStart : `${anchoredStart}$`;
  return anchoredEnd;
}

function hasNestedQuantifiers(pattern: string): boolean {
  const nested = /\((?:[^\\]|\\.)*?[+*{](?:[^\\]|\\.)*?\)[+*{]/;
  return nested.test(pattern);
}

function parseAllowCompositeEntries(
  entries: string[],
  context: string,
  ErrorType: new (message: string) => Error
): { allowList: boolean; allowRead: boolean } {
  let allowList = false;
  let allowRead = false;

  for (const entry of entries) {
    if (entry === '_allow_list') {
      allowList = true;
    } else if (entry === '_allow_read') {
      allowRead = true;
    } else if (entry) {
      throw new ErrorType(`${context} supports only _allow_list or _allow_read values.`);
    }
  }

  return { allowList, allowRead };
}

function resolveOperationCategory(operation: OperationInfo): 'list' | 'read' | 'modify' {
  const method = operation.method.toLowerCase();
  if (method === 'get') {
    const hasPathParams = operation.parameters.some(param => param.in === 'path');
    return hasPathParams ? 'read' : 'list';
  }
  return 'modify';
}

function getAllowMatchReasons(
  tool: ToolDefinition,
  normalizedName: string,
  config: ToolFilterConfig,
  resolver?: ToolFilterOperationResolver
): string[] {
  const reasons: string[] = [];

  if (config.allowList.has(normalizedName)) {
    reasons.push(`allow_list:${normalizedName}`);
  }
  for (const regex of config.allowRegex) {
    if (regex.test(normalizedName)) {
      reasons.push(`allow_regex:${regex.source}`);
    }
  }

  if (config.allowComposite.allowList || config.allowComposite.allowRead) {
    const listRead = detectListReadOperations(tool, resolver);
    if (config.allowComposite.allowList && listRead.isList) {
      reasons.push('allow_composite:_allow_list');
    }
    if (config.allowComposite.allowRead && listRead.isRead) {
      reasons.push('allow_composite:_allow_read');
    }
  }

  return reasons;
}

function getSessionAllowReasons(
  tool: ToolDefinition,
  normalizedName: string,
  request: SessionToolFilterRequest,
  resolver?: ToolFilterOperationResolver
): string[] {
  const reasons: string[] = [];

  if (request.exactNames.has(normalizedName)) {
    reasons.push(`header_exact:${normalizedName}`);
  }
  for (const regex of request.regexPatterns) {
    if (regex.test(normalizedName)) {
      reasons.push(`header_regex:${regex.source}`);
    }
  }

  if (request.allowComposite.allowList || request.allowComposite.allowRead) {
    const listRead = detectListReadOperations(tool, resolver);
    if (request.allowComposite.allowList && listRead.isList) {
      reasons.push('header_composite:_allow_list');
    }
    if (request.allowComposite.allowRead && listRead.isRead) {
      reasons.push('header_composite:_allow_read');
    }
  }

  return reasons;
}

function getAllowFailureReasons(config: ToolFilterConfig): string[] {
  const reasons: string[] = [];
  if (config.sources.allowList.length > 0) {
    reasons.push('allow_list');
  }
  if (config.sources.allowRegex.length > 0) {
    reasons.push('allow_regex');
  }
  if (config.allowComposite.allowList) {
    reasons.push('_allow_list');
  }
  if (config.allowComposite.allowRead) {
    reasons.push('_allow_read');
  }
  return reasons.length > 0 ? reasons : ['allow'];
}

function buildNormalizedSessionEntries(params: {
  exactNames: Set<string>;
  regexPatterns: RegExp[];
  allowComposite: { allowList: boolean; allowRead: boolean };
}): string[] {
  const entries: string[] = [];

  for (const name of params.exactNames) {
    entries.push(name);
  }

  for (const regex of params.regexPatterns) {
    entries.push(`regex:${regex.source}`);
  }

  if (params.allowComposite.allowList) {
    entries.push('_allow_list');
  }
  if (params.allowComposite.allowRead) {
    entries.push('_allow_read');
  }

  return entries;
}
