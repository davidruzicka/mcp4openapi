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
  allowCategories: Set<'list' | 'read'>;
  hasAllowRules: boolean;
  sources: {
    allowList: string[];
    allowRegex: string[];
    denyList: string[];
    denyRegex: string[];
    allowCategories: string[];
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
  return trimmed.length > 0 ? trimmed : '';
}

export function parseToolFilterConfig(env: NodeJS.ProcessEnv): ToolFilterConfig | undefined {
  const allowListRaw = env.MCP4_TOOL_FILTER_ALLOW_NAMES;
  const allowRegexRaw = env.MCP4_TOOL_FILTER_ALLOW_NAME_REGEX;
  const denyListRaw = env.MCP4_TOOL_FILTER_DENY_NAMES;
  const denyRegexRaw = env.MCP4_TOOL_FILTER_DENY_NAME_REGEX;
  const allowCategoriesRaw = env.MCP4_TOOL_FILTER_ALLOW_CATEGORIES;

  const hasAnyEnv =
    allowListRaw !== undefined ||
    allowRegexRaw !== undefined ||
    denyListRaw !== undefined ||
    denyRegexRaw !== undefined ||
    allowCategoriesRaw !== undefined;

  if (!hasAnyEnv) {
    return undefined;
  }

  const allowListEntries = parseCsvList(allowListRaw);
  const denyListEntries = parseCsvList(denyListRaw);
  const allowRegexEntries = parseCsvList(allowRegexRaw);
  const denyRegexEntries = parseCsvList(denyRegexRaw);
  const allowCategoryEntries = parseCsvList(allowCategoriesRaw);

  const allowList = new Set(allowListEntries.map(normalizeToolName));
  const denyList = new Set(denyListEntries.map(normalizeToolName));
  const allowRegex = allowRegexEntries.map(pattern =>
    compileRegex(pattern, 'MCP4_TOOL_FILTER_ALLOW_NAME_REGEX', ConfigurationError)
  );
  const denyRegex = denyRegexEntries.map(pattern =>
    compileRegex(pattern, 'MCP4_TOOL_FILTER_DENY_NAME_REGEX', ConfigurationError)
  );

  const allowCategories = parseAllowCategoryEntries(
    allowCategoryEntries,
    'MCP4_TOOL_FILTER_ALLOW_CATEGORIES',
    ConfigurationError
  );

  return {
    allowList,
    denyList,
    allowRegex,
    denyRegex,
    allowCategories,
    hasAllowRules:
      allowListEntries.length > 0 ||
      allowRegexEntries.length > 0 ||
      allowCategories.size > 0,
    sources: {
      allowList: allowListEntries,
      allowRegex: allowRegexEntries,
      denyList: denyListEntries,
      denyRegex: denyRegexEntries,
      allowCategories: allowCategoryEntries,
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
    // Strict classification for composite tools:
    // - isList: every step is a list operation
    // - isRead: every step is a read operation
    // Mixed list+read composites are neither list nor read.
    // Any non-GET step (modify) makes it neither list nor read.
    let hasAny = false;
    let allList = true;
    let allRead = true;

    for (const step of tool.steps) {
      const operation = resolver.getOperationForCall(step.call);
      if (!operation) {
        allList = false;
        allRead = false;
        continue;
      }
      hasAny = true;
      const category = resolveOperationCategory(operation);
      if (category !== 'list') {
        allList = false;
      }
      if (category !== 'read') {
        allRead = false;
      }
    }

    isList = hasAny && allList;
    isRead = hasAny && allRead;
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

  if (hasAmbiguousAlternation(pattern)) {
    return {
      valid: false,
      error: 'Regex pattern contains alternation with a quantifier.',
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

function hasAmbiguousAlternation(pattern: string): boolean {
  const alternation = /\((?:[^\\]|\\.)*?\|(?:[^\\]|\\.)*?\)[+*{]/;
  return alternation.test(pattern);
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

function parseAllowCategoryEntries(
  entries: string[],
  context: string,
  ErrorType: new (message: string) => Error
): Set<'list' | 'read'> {
  const categories = new Set<'list' | 'read'>();
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    const normalized = entry.trim().toLowerCase();
    if (normalized === 'list' || normalized === 'read') {
      categories.add(normalized);
      continue;
    }
    throw new ErrorType(`${context} supports only 'list' and/or 'read' values.`);
  }
  return categories;
}

function resolveOperationCategory(operation: OperationInfo): 'list' | 'read' | 'modify' {
  const method = operation.method.toLowerCase();
  if (method === 'get') {
    const hasPathParams = operation.parameters.some(param => param.in === 'path');
    return hasPathParams ? 'read' : 'list';
  }
  return 'modify';
}

function classifyToolOperations(
  tool: ToolDefinition,
  resolver?: ToolFilterOperationResolver
): { hasList: boolean; hasRead: boolean; hasModify: boolean } {
  let hasList = false;
  let hasRead = false;
  let hasModify = false;

  if (tool.composite && tool.steps && resolver?.getOperationForCall) {
    for (const step of tool.steps) {
      const operation = resolver.getOperationForCall(step.call);
      if (!operation) {
        hasModify = true;
        continue;
      }
      const category = resolveOperationCategory(operation);
      if (category === 'list') {
        hasList = true;
      } else if (category === 'read') {
        hasRead = true;
      } else {
        hasModify = true;
      }
    }
    return { hasList, hasRead, hasModify };
  }

  if (tool.operations) {
    for (const [action, operationId] of Object.entries(tool.operations)) {
      if (typeof operationId === 'string' && resolver?.getOperationById) {
        const operation = resolver.getOperationById(operationId);
        if (operation) {
          const category = resolveOperationCategory(operation);
          if (category === 'list') {
            hasList = true;
          } else if (category === 'read') {
            hasRead = true;
          } else {
            hasModify = true;
          }
          continue;
        }
      }

      const actionValue = action.toLowerCase();
      if (actionValue === 'list' || actionValue === 'search') {
        hasList = true;
      } else if (actionValue === 'get' || actionValue === 'read') {
        hasRead = true;
      } else {
        hasModify = true;
      }
    }
    return { hasList, hasRead, hasModify };
  }

  // Unknown tool type (no operations and not a resolvable composite): treat as modify (unsafe)
  return { hasList: false, hasRead: false, hasModify: true };
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

  if (config.allowCategories.size > 0) {
    const { hasList, hasRead, hasModify } = classifyToolOperations(tool, resolver);
    const isListOnly = hasList && !hasRead && !hasModify;
    const isReadOnly = hasRead && !hasList && !hasModify;
    const isListReadOnly = (hasList || hasRead) && !hasModify;

    if (config.allowCategories.has('list') && config.allowCategories.has('read')) {
      if (isListReadOnly) {
        reasons.push('allow_categories:list,read');
      }
    } else if (config.allowCategories.has('list')) {
      if (isListOnly) {
        reasons.push('allow_categories:list');
      }
    } else if (config.allowCategories.has('read')) {
      if (isReadOnly) {
        reasons.push('allow_categories:read');
      }
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
  if (config.sources.allowCategories.length > 0) {
    reasons.push('allow_categories');
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
