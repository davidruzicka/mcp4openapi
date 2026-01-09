import type { ToolDefinition } from './types/profile.js';
import { ConfigurationError, ValidationError } from './errors.js';

const MAX_REGEX_LENGTH = 100;

export interface ToolFilterRegexRule {
  pattern: string;
  regex: RegExp;
}

export interface ToolFilterConfig {
  allowList: string[];
  allowRegex: ToolFilterRegexRule[];
  denyList: string[];
  denyRegex: ToolFilterRegexRule[];
  allowComposite: {
    allowList: boolean;
    allowRead: boolean;
  };
}

export interface ToolFilterResult {
  allowed: ToolDefinition[];
  removed: ToolDefinition[];
  reasons: Map<string, string>;
}

export interface SessionToolFilterRequest {
  originalHeader: string;
  allowNames: string[];
  allowRegex: ToolFilterRegexRule[];
  allowComposite: {
    allowList: boolean;
    allowRead: boolean;
  };
}

export interface SessionToolFilterState extends SessionToolFilterRequest {
  allowedToolNames: Set<string>;
}

export interface SessionToolFilterResult {
  allowedTools: ToolDefinition[];
  removedTools: ToolDefinition[];
  allowedToolNames: Set<string>;
  reasons: Map<string, string>;
  hasEffect: boolean;
}

export function normalizeToolName(name: string): string {
  return name.normalize('NFC');
}

export function parseToolFilterConfig(env: NodeJS.ProcessEnv): ToolFilterConfig | null {
  const allowList = parseCommaList(env.MCP4_TOOL_FILTER_ALLOW_LIST).map(normalizeToolName);
  const allowRegex = parseRegexList(env.MCP4_TOOL_FILTER_ALLOW_REGEX, 'MCP4_TOOL_FILTER_ALLOW_REGEX');
  const denyList = parseCommaList(env.MCP4_TOOL_FILTER_DENY_LIST).map(normalizeToolName);
  const denyRegex = parseRegexList(env.MCP4_TOOL_FILTER_DENY_REGEX, 'MCP4_TOOL_FILTER_DENY_REGEX');
  const allowComposite = parseAllowComposites(env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES);

  if (
    allowList.length === 0 &&
    allowRegex.length === 0 &&
    denyList.length === 0 &&
    denyRegex.length === 0 &&
    !allowComposite.allowList &&
    !allowComposite.allowRead
  ) {
    return null;
  }

  return {
    allowList,
    allowRegex,
    denyList,
    denyRegex,
    allowComposite,
  };
}

export function parseSessionToolFilterHeader(
  headerValue: string,
  options: { maxEntries: number; maxEntryLength: number }
): SessionToolFilterRequest {
  const normalizedHeader = headerValue.trim();
  const allowNames: string[] = [];
  const allowRegex: ToolFilterRegexRule[] = [];
  const allowComposite = {
    allowList: false,
    allowRead: false,
  };

  const entries = normalizedHeader.length > 0 ? normalizedHeader.split(',') : [''];
  const trimmedEntries = entries
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

  if (trimmedEntries.length > options.maxEntries) {
    throw new ValidationError(
      `X-Mcp4-Tools contains too many entries (${trimmedEntries.length} > ${options.maxEntries}). Reduce to ${options.maxEntries} or configure MCP4_TOOL_FILTER_SESSION_MAX_TOOLS.`
    );
  }

  for (const entry of trimmedEntries) {
    if (entry.length > options.maxEntryLength) {
      throw new ValidationError(
        `X-Mcp4-Tools entry exceeds ${options.maxEntryLength} chars: '${entry}' (${entry.length} chars).`
      );
    }

    if (entry === '_allow_list') {
      allowComposite.allowList = true;
      continue;
    }

    if (entry === '_allow_read') {
      allowComposite.allowRead = true;
      continue;
    }

    if (entry.startsWith('regex:')) {
      const rawPattern = entry.slice('regex:'.length).trim();
      if (!rawPattern) {
        throw new ValidationError('X-Mcp4-Tools regex entry must include a pattern.');
      }
      const anchored = autoAnchorPattern(rawPattern.normalize('NFC'));
      allowRegex.push(compileSessionRegexRule(anchored, 'X-Mcp4-Tools'));
      continue;
    }

    allowNames.push(normalizeToolName(entry));
  }

  return {
    originalHeader: normalizedHeader,
    allowNames,
    allowRegex,
    allowComposite,
  };
}

export function applyToolFilter(tools: ToolDefinition[], config: ToolFilterConfig): ToolFilterResult {
  const allowed: ToolDefinition[] = [];
  const removed: ToolDefinition[] = [];
  const reasons = new Map<string, string>();

  const hasAllowRules =
    config.allowList.length > 0 ||
    config.allowRegex.length > 0 ||
    config.allowComposite.allowList ||
    config.allowComposite.allowRead;

  const allowListSet = new Set(config.allowList);
  const denyListSet = new Set(config.denyList);

  for (const tool of tools) {
    const toolName = normalizeToolName(tool.name);
    let allowedByAllowRules = !hasAllowRules;
    if (!allowedByAllowRules) {
      if (allowListSet.has(toolName) || matchesRegex(toolName, config.allowRegex)) {
        allowedByAllowRules = true;
      } else if (tool.composite) {
        const { isList, isRead } = detectListReadOperations(tool);
        if (config.allowComposite.allowList && isList) {
          allowedByAllowRules = true;
        }
        if (config.allowComposite.allowRead && isRead) {
          allowedByAllowRules = true;
        }
      }
    }

    if (!allowedByAllowRules) {
      removed.push(tool);
      reasons.set(toolName, 'allow_rules');
      continue;
    }

    if (denyListSet.has(toolName)) {
      removed.push(tool);
      reasons.set(toolName, 'deny_list');
      continue;
    }

    const denyPattern = findMatchingPattern(toolName, config.denyRegex);
    if (denyPattern) {
      removed.push(tool);
      reasons.set(toolName, `deny_regex:${denyPattern}`);
      continue;
    }

    allowed.push(tool);
  }

  return { allowed, removed, reasons };
}

export function applySessionToolFilter(
  tools: ToolDefinition[],
  request: SessionToolFilterRequest
): SessionToolFilterResult {
  const allowedTools: ToolDefinition[] = [];
  const removedTools: ToolDefinition[] = [];
  const reasons = new Map<string, string>();
  const allowedToolNames = new Set<string>();

  const hasAllowRules =
    request.allowNames.length > 0 ||
    request.allowRegex.length > 0 ||
    request.allowComposite.allowList ||
    request.allowComposite.allowRead;

  const allowNameSet = new Set(request.allowNames);

  for (const tool of tools) {
    const toolName = normalizeToolName(tool.name);
    let allowed = !hasAllowRules;

    if (!allowed) {
      if (allowNameSet.has(toolName) || matchesRegex(toolName, request.allowRegex)) {
        allowed = true;
      } else if (tool.composite) {
        const { isList, isRead } = detectListReadOperations(tool);
        if (request.allowComposite.allowList && isList) {
          allowed = true;
        }
        if (request.allowComposite.allowRead && isRead) {
          allowed = true;
        }
      }
    }

    if (allowed) {
      allowedTools.push(tool);
      allowedToolNames.add(toolName);
    } else {
      removedTools.push(tool);
      reasons.set(toolName, 'allow_rules');
    }
  }

  return {
    allowedTools,
    removedTools,
    allowedToolNames,
    reasons,
    hasEffect: removedTools.length > 0,
  };
}

export function detectListReadOperations(tool: ToolDefinition): { isList: boolean; isRead: boolean } {
  const actionNames = new Set<string>();

  if (tool.parameters?.action?.enum) {
    for (const action of tool.parameters.action.enum) {
      actionNames.add(action.toLowerCase());
    }
  }

  if (tool.operations) {
    for (const key of Object.keys(tool.operations)) {
      const [actionPart] = key.split('_');
      if (actionPart) {
        actionNames.add(actionPart.toLowerCase());
      }
    }
  }

  return {
    isList: actionNames.has('list') || actionNames.has('search'),
    isRead: actionNames.has('get') || actionNames.has('read'),
  };
}

export function validateRegexPattern(pattern: string, maxLength: number = MAX_REGEX_LENGTH): { valid: boolean; error?: string } {
  if (pattern.length > maxLength) {
    return { valid: false, error: `Regex pattern too long (max ${maxLength} chars).` };
  }

  if (containsNestedQuantifier(pattern)) {
    return { valid: false, error: 'Regex pattern contains nested quantifiers.' };
  }

  try {
    new RegExp(pattern);
  } catch (error) {
    return { valid: false, error: `Regex syntax error: ${(error as Error).message}` };
  }

  return { valid: true };
}

export function getSessionToolFilterMaxEntries(): number {
  const raw = process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS;
  if (raw === undefined) {
    return 100;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ValidationError(
      `Invalid MCP4_TOOL_FILTER_SESSION_MAX_TOOLS: expected positive integer, got '${raw}'.`
    );
  }
  return parsed;
}

function parseCommaList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function parseAllowComposites(value: string | undefined): { allowList: boolean; allowRead: boolean } {
  const entries = parseCommaList(value);
  const allowList = entries.includes('_allow_list');
  const allowRead = entries.includes('_allow_read');

  for (const entry of entries) {
    if (entry !== '_allow_list' && entry !== '_allow_read') {
      throw new ConfigurationError(
        `Invalid MCP4_TOOL_FILTER_ALLOW_COMPOSITES entry '${entry}'. Expected _allow_list or _allow_read.`
      );
    }
  }

  return { allowList, allowRead };
}

function parseRegexList(value: string | undefined, envName: string): ToolFilterRegexRule[] {
  const entries = parseCommaList(value);
  if (entries.length === 0) {
    return [];
  }

  return entries.map(entry => {
    const anchored = autoAnchorPattern(entry.normalize('NFC'));
    return compileRegexRule(anchored, envName);
  });
}

function compileRegexRule(pattern: string, source: string): ToolFilterRegexRule {
  const validation = validateRegexPattern(pattern);
  if (!validation.valid) {
    throw new ConfigurationError(`${source} regex validation failed for '${pattern}': ${validation.error}`);
  }

  return {
    pattern,
    regex: new RegExp(pattern),
  };
}

function compileSessionRegexRule(pattern: string, source: string): ToolFilterRegexRule {
  const validation = validateRegexPattern(pattern);
  if (!validation.valid) {
    throw new ValidationError(`${source} regex validation failed for '${pattern}': ${validation.error}`);
  }

  return {
    pattern,
    regex: new RegExp(pattern),
  };
}

function autoAnchorPattern(pattern: string): string {
  const hasStart = pattern.startsWith('^');
  const hasEnd = pattern.endsWith('$');

  let anchored = pattern;
  if (!hasStart) {
    anchored = `^${anchored}`;
  }
  if (!hasEnd) {
    anchored = `${anchored}$`;
  }

  return anchored;
}

function matchesRegex(name: string, rules: ToolFilterRegexRule[]): boolean {
  return rules.some(rule => rule.regex.test(name));
}

function findMatchingPattern(name: string, rules: ToolFilterRegexRule[]): string | undefined {
  const match = rules.find(rule => rule.regex.test(name));
  return match?.pattern;
}

function containsNestedQuantifier(pattern: string): boolean {
  const nestedQuantifier = /\((?:[^()\\]|\\.)*(?:\+|\*|\?|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:\+|\*|\?|\{\d+(?:,\d*)?\})/;
  return nestedQuantifier.test(pattern);
}
