/**
 * Tool Filtering Module
 *
 * Why: Implements global (static) and session (dynamic) tool filtering logic.
 * Enforces security policies defined via environment variables and HTTP headers.
 */

import safeRegex from 'safe-regex';
import type { ToolDefinition } from './types/profile.js';
import { ConfigurationError, ValidationError } from './errors.js';

// Configuration interface for global filters
export interface ToolFilterConfig {
  allowList?: Set<string>;
  allowRegex?: RegExp[];
  denyList?: Set<string>;
  denyRegex?: RegExp[];
  allowComposites?: boolean; // If true, auto-allows list/read composite tools
}

// Result of filtering application
export interface ToolFilterResult {
  allowed: ToolDefinition[];
  removed: ToolDefinition[];
  reasons: Map<string, string>;
}

export interface RegexValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Parse global tool filter configuration from environment variables
 */
export function parseToolFilterConfig(env: NodeJS.ProcessEnv): ToolFilterConfig | undefined {
  const allowListStr = env.MCP4_TOOL_FILTER_ALLOW_LIST;
  const allowRegexStr = env.MCP4_TOOL_FILTER_ALLOW_REGEX;
  const denyListStr = env.MCP4_TOOL_FILTER_DENY_LIST;
  const denyRegexStr = env.MCP4_TOOL_FILTER_DENY_REGEX;
  const allowComposites = env.MCP4_TOOL_FILTER_ALLOW_COMPOSITES === 'true';

  if (!allowListStr && !allowRegexStr && !denyListStr && !denyRegexStr) {
    return undefined;
  }

  const config: ToolFilterConfig = {
    allowComposites
  };

  if (allowListStr) {
    config.allowList = new Set(splitAndTrim(allowListStr));
  }

  if (denyListStr) {
    config.denyList = new Set(splitAndTrim(denyListStr));
  }

  if (allowRegexStr) {
    config.allowRegex = parseRegexPatterns(allowRegexStr);
  }

  if (denyRegexStr) {
    config.denyRegex = parseRegexPatterns(denyRegexStr);
  }

  return config;
}

/**
 * Apply tool filter configuration to a list of tools
 */
export function applyToolFilter(tools: ToolDefinition[], config: ToolFilterConfig): ToolFilterResult {
  const allowed: ToolDefinition[] = [];
  const removed: ToolDefinition[] = [];
  const reasons = new Map<string, string>();

  // If no filters defined, return all tools (unless config itself is empty, but caller handles that)
  // However, check if allow filters exist - if so, default is deny unless matched.
  // If only deny filters exist, default is allow unless matched.
  const hasAllowFilters = (config.allowList && config.allowList.size > 0) ||
                          (config.allowRegex && config.allowRegex.length > 0);

  for (const tool of tools) {
    let isAllowed = true;
    let removalReason = '';

    // Check Deny Rules First (Precedence)
    if (config.denyList?.has(tool.name)) {
      isAllowed = false;
      removalReason = `Matched DENY_LIST: ${tool.name}`;
    } else if (config.denyRegex?.some(regex => regex.test(tool.name))) {
      isAllowed = false;
      removalReason = 'Matched DENY_REGEX';
    } else {
      // If allowed so far, check Allow Rules (if any exist)
      if (hasAllowFilters) {
        let explicitMatch = false;

        if (config.allowList?.has(tool.name)) {
          explicitMatch = true;
        } else if (config.allowRegex?.some(regex => regex.test(tool.name))) {
          explicitMatch = true;
        }

        // Handle composite tool auto-allowance
        if (!explicitMatch && config.allowComposites && tool.composite) {
          const { isList, isRead } = detectListReadOperations(tool);
          if (isList || isRead) {
             explicitMatch = true;
          }
        }

        if (!explicitMatch) {
          isAllowed = false;
          removalReason = 'Not in ALLOW_LIST/REGEX';
        }
      }
    }

    if (isAllowed) {
      allowed.push(tool);
    } else {
      removed.push(tool);
      reasons.set(tool.name, removalReason);
    }
  }

  return { allowed, removed, reasons };
}

/**
 * Detect if a tool is a "list" or "read" operation based on heuristics
 * Used for auto-allowing composite tools
 */
export function detectListReadOperations(tool: ToolDefinition): { isList: boolean, isRead: boolean } {
  // Simple heuristics based on tool name and description
  const name = tool.name.toLowerCase();

  // "List" heuristics
  const isList =
    name.startsWith('list') ||
    name.startsWith('search') ||
    name.includes('_list_') ||
    name.endsWith('_list');

  // "Read" heuristics (get/read)
  const isRead =
    name.startsWith('get') ||
    name.startsWith('read') ||
    name.includes('_get_') ||
    name.endsWith('_get');

  return { isList, isRead };
}

/**
 * Validate and compile regex pattern with ReDoS protection
 */
export function validateRegexPattern(pattern: string): RegexValidationResult {
  // Check length limit (defense in depth)
  if (pattern.length > 100) {
    return { valid: false, error: 'Regex pattern too long (max 100 chars)' };
  }

  try {
    // Try compiling first to catch syntax errors
    new RegExp(pattern);

    // Then use safe-regex to validate for ReDoS
    // Note: safe-regex might not catch everything, but it covers common cases
    if (!safeRegex(pattern)) {
       return { valid: false, error: 'Regex pattern detected as potentially unsafe (ReDoS risk)' };
    }

    return { valid: true };
  } catch (e) {
    return { valid: false, error: `Invalid regex syntax: ${(e as Error).message}` };
  }
}

/**
 * Parse regex patterns string (comma-separated, auto-anchored)
 */
function parseRegexPatterns(patternsStr: string): RegExp[] {
  // First split by comma, respecting escaped commas if any (simple split for now as env vars usually don't have complex regexes with commas)
  // In env vars, complex regexes might be tricky. We assume standard comma separation.
  const patterns = splitAndTrim(patternsStr);
  const compiled: RegExp[] = [];

  for (const pattern of patterns) {
    const validation = validateRegexPattern(pattern);
    if (!validation.valid) {
      throw new ConfigurationError(`Invalid regex pattern '${pattern}': ${validation.error}`);
    }

    // Auto-anchoring: if not already anchored, wrap in ^...$
    let finalPattern = pattern;
    if (!finalPattern.startsWith('^')) {
      finalPattern = '^' + finalPattern;
    }
    if (!finalPattern.endsWith('$')) {
      finalPattern = finalPattern + '$';
    }

    try {
      compiled.push(new RegExp(finalPattern));
    } catch (e) {
      throw new ConfigurationError(`Failed to compile regex '${finalPattern}': ${(e as Error).message}`);
    }
  }

  return compiled;
}

function splitAndTrim(str: string): string[] {
  return str.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
