/**
 * Upstream tool sanitizer
 *
 * Validates tool names and descriptions received from upstream MCP servers
 * before exposing them to downstream clients. Drops offending tools with
 * a warning instead of forwarding potentially injected content.
 *
 * Security: drops tools whose name is outside [a-zA-Z0-9_-], whose description
 * contains injection-prone characters (<, >, backtick), or whose inputSchema
 * contains forbidden characters in any key or string value (recursive scan to
 * depth 10; schemas exceeding the depth limit are treated as malicious). Truncates
 * tool names in dropped output to 100 chars + ellipsis (103 chars max) to
 * prevent log injection via maliciously long upstream tool names (D-03, D-04, D-05).
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { sanitizeLogMessage } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { UpstreamMcpToolPolicy } from '../types/profile.js';

export type HtmlDescriptionPolicy = 'allow' | 'strip' | 'drop';
export type ToolDescriptionLengthPolicy = 'drop' | 'truncate' | 'allow';

export interface SanitizationResult {
  tools: Tool[];
  dropped: { name: string; reason: string }[];
}

// Data-driven constraints
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DESCRIPTION_FORBIDDEN_CHARS = /[<>`]/;
const HTML_TAG_PATTERN = /<[^>]*>/g;

const MAX_EXCERPT_CONTEXT = 40;

function firstForbiddenExcerpt(text: string): string {
  const idx = text.search(DESCRIPTION_FORBIDDEN_CHARS);
  if (idx === -1) return '';
  const start = Math.max(0, idx - MAX_EXCERPT_CONTEXT);
  const end = Math.min(text.length, idx + MAX_EXCERPT_CONTEXT + 1);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}

function stripHtmlTags(text: string): string {
  // Repeat until fixpoint: removing a multi-char match can join the surrounding
  // text into a new tag (incomplete multi-character sanitization, CWE-116).
  // The loop also caps pathological cases the single-pass replace would miss.
  let previous: string;
  let result = text;
  do {
    previous = result;
    result = result.replace(HTML_TAG_PATTERN, '');
  } while (result !== previous);
  return result;
}

function stripHtmlFromSchema(value: unknown, depth = 0): unknown {
  if (depth > 10) return value;
  if (typeof value === 'string') return stripHtmlTags(value);
  if (Array.isArray(value)) return value.map(v => stripHtmlFromSchema(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = stripHtmlFromSchema(v, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Recursively scan a JSON Schema object for forbidden characters in both keys and string values.
 * Returns true if any key or string value contains forbidden chars.
 * Depth limit guards against deeply nested schemas.
 */
function schemaContainsForbiddenChars(value: unknown, depth = 0): boolean {
  // Treat schemas exceeding the recursion limit as potentially malicious: a legitimate
  // schema has no reason to be this deeply nested, and returning false here would allow
  // a well-crafted upstream schema to hide forbidden characters beyond depth 10.
  if (depth > 10) return true;
  if (typeof value === 'string') return DESCRIPTION_FORBIDDEN_CHARS.test(value);
  if (Array.isArray(value)) return value.some(v => schemaContainsForbiddenChars(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    // Scan keys (e.g. property names under `properties`) as well as values;
    // forbidden chars placed in keys would bypass a values-only scan.
    return Object.keys(obj).some(k => DESCRIPTION_FORBIDDEN_CHARS.test(k)) ||
      Object.values(obj).some(v => schemaContainsForbiddenChars(v, depth + 1));
  }
  return false;
}
const MAX_TOOL_NAME_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2048;
const MAX_DROPPED_NAME_LENGTH = 100;

const truncateName = (name: string): string =>
  name.length > MAX_DROPPED_NAME_LENGTH
    ? name.slice(0, MAX_DROPPED_NAME_LENGTH) + '...'
    : name;

/**
 * Sanitize a list of tools received from an upstream MCP server.
 *
 * Each tool is checked in order:
 *   1. Name length <= 255
 *   2. Name matches [a-zA-Z0-9_-]
 *   3. Description length policy (tool_description_length_policy):
 *      - drop (default): tools with description > 2048 chars are dropped
 *      - truncate: description is truncated to 2048 chars; tool is kept
 *      - allow: description length check is skipped; tool passes through unchanged
 *   4. HTML policy (html_description_policy):
 *      - drop (default): tools with <, >, or backtick in description/inputSchema are dropped
 *      - strip: HTML tags stripped from description and inputSchema string values; tool kept
 *      - allow: HTML checks skipped entirely; tool passes through as-is
 *
 * Offending tools are dropped and logged. Safe tools pass through unchanged.
 */
export function sanitizeToolList(
  tools: Tool[],
  logger?: Logger,
  htmlPolicy: HtmlDescriptionPolicy = 'drop',
  lengthPolicy: ToolDescriptionLengthPolicy = 'drop',
): SanitizationResult {
  const safe: Tool[] = [];
  const dropped: { name: string; reason: string }[] = [];

  for (let tool of tools) {
    // Guard: upstream may return null or non-object entries (e.g. null items in tools array)
    if (tool === null || typeof tool !== 'object') {
      const safeName = sanitizeLogMessage(truncateName(String(tool)));
      const reason = 'malformed tool definition: entry is not an object';
      dropped.push({ name: safeName, reason });
      logger?.warn('Dropped upstream tool due to sanitization failure', { name: safeName, reason });
      continue;
    }

    let reason: string | undefined;
    let excerpt: string | undefined;

    // Runtime type guards: upstream may return non-string fields despite SDK types
    if (typeof tool.name !== 'string') {
      reason = 'malformed tool definition: name is not a string';
    } else if (tool.name.length > MAX_TOOL_NAME_LENGTH) {
      reason = 'tool name too long';
    } else if (!TOOL_NAME_PATTERN.test(tool.name)) {
      reason = 'invalid characters in tool name';
    } else if (tool.description !== undefined && typeof tool.description !== 'string') {
      reason = 'malformed tool definition: description is not a string';
    } else {
      // Description length policy: applies only to description length, not to other checks.
      // Evaluated independently so that 'allow'/'truncate' can still fall through to HTML checks.
      if (tool.description && tool.description.length > MAX_DESCRIPTION_LENGTH) {
        if (lengthPolicy === 'drop') {
          reason = 'tool description too long';
        } else if (lengthPolicy === 'truncate') {
          tool = { ...tool, description: tool.description.slice(0, MAX_DESCRIPTION_LENGTH) };
        }
        // lengthPolicy === 'allow': skip length check, continue to other checks unchanged
      }

      if (reason === undefined) {
        if (tool.inputSchema !== undefined && (typeof tool.inputSchema !== 'object' || tool.inputSchema === null || Array.isArray(tool.inputSchema))) {
          reason = 'malformed tool definition: inputSchema is not an object';
        } else if (htmlPolicy === 'drop') {
          if (tool.description && DESCRIPTION_FORBIDDEN_CHARS.test(tool.description)) {
            reason = 'forbidden characters in description';
            excerpt = firstForbiddenExcerpt(tool.description);
          } else if (tool.inputSchema && schemaContainsForbiddenChars(tool.inputSchema)) {
            reason = 'forbidden characters in input schema';
            const schemaStr = JSON.stringify(tool.inputSchema);
            excerpt = firstForbiddenExcerpt(schemaStr);
          }
        } else if (htmlPolicy === 'strip') {
          if (tool.description) {
            tool = { ...tool, description: stripHtmlTags(tool.description) };
          }
          if (tool.inputSchema) {
            tool = { ...tool, inputSchema: stripHtmlFromSchema(tool.inputSchema) as Tool['inputSchema'] };
          }
        }
        // htmlPolicy === 'allow': skip all HTML checks, pass tool through unchanged
      }
    }

    if (reason !== undefined) {
      // Coerce non-string names to string for safe logging
      const nameStr = typeof tool.name === 'string' ? tool.name : String(tool.name);
      const safeName = sanitizeLogMessage(truncateName(nameStr));
      const safeExcerpt = excerpt ? sanitizeLogMessage(excerpt) : undefined;
      dropped.push({ name: safeName, reason });
      logger?.warn('Dropped upstream tool due to sanitization failure', {
        name: safeName,
        reason,
        ...(safeExcerpt !== undefined && { excerpt: safeExcerpt }),
      });
    } else {
      safe.push(tool);
    }
  }

  return { tools: safe, dropped };
}

/**
 * Check whether a tool name passes the upstream name policy.
 * Used to validate tool names in tools/call before forwarding to upstream,
 * preventing callers from invoking tools that were dropped from the sanitized list.
 */
export function isValidUpstreamToolName(name: string): boolean {
  return name.length <= MAX_TOOL_NAME_LENGTH && TOOL_NAME_PATTERN.test(name);
}

/**
 * Match a single glob pattern against a tool name.
 * Supports `*` as a wildcard (matches any sequence of valid tool name chars).
 * Fast path skips regex for exact-match patterns (no `*`).
 */
const compiledGlobCache = new Map<string, RegExp>();

function matchesGlobPattern(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  let re = compiledGlobCache.get(pattern);
  if (!re) {
    const regexStr = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[a-zA-Z0-9_-]*');
    re = new RegExp(`^${regexStr}$`);
    compiledGlobCache.set(pattern, re);
  }
  return re.test(name);
}

/**
 * Apply the profile-level upstream tool policy (allow/deny lists) to a tool list.
 *
 * Semantics:
 *   - allow list: only tools matching at least one pattern pass
 *   - deny list: tools matching any pattern are rejected
 *   - both set: allow is evaluated first (tool must match allow AND not match deny)
 *   - neither set: all tools pass
 *
 * Patterns support `*` as a wildcard (e.g. `github_*`, `admin_*`).
 *
 * Availability signal: allow-list entries that match none of the upstream tools
 * are logged once per invocation. Filtering stays fail-closed (a dead entry
 * simply exposes nothing), but a tool renamed or removed upstream would
 * otherwise vanish silently.
 */
export function applyProviderToolPolicy(
  tools: Tool[],
  policy: UpstreamMcpToolPolicy | undefined,
  logger?: Pick<Logger, 'warn'>,
): Tool[] {
  if (!policy) return tools;
  const { allow, deny } = policy;
  if (logger && allow && allow.length > 0) {
    const unmatched = allow.filter((pattern) => !tools.some((tool) => matchesGlobPattern(pattern, tool.name)));
    if (unmatched.length > 0) {
      logger.warn('Upstream tool allow-list entries matched no upstream tools - they may have been renamed or removed upstream', {
        unmatchedAllowPatterns: unmatched.map((pattern) => sanitizeLogMessage(truncateName(pattern))),
      });
    }
  }
  return tools.filter((tool) => {
    if (allow && !allow.some(p => matchesGlobPattern(p, tool.name))) return false;
    if (deny && deny.some(p => matchesGlobPattern(p, tool.name))) return false;
    return true;
  });
}

/**
 * Check whether a single tool name is permitted by the upstream tool policy.
 * Used in tools/call to enforce allow/deny before forwarding.
 * Patterns support `*` as a wildcard (e.g. `github_*`, `admin_*`).
 */
export function isToolAllowedByProviderPolicy(toolName: string, policy: UpstreamMcpToolPolicy | undefined): boolean {
  if (!policy) return true;
  if (policy.allow && !policy.allow.some(p => matchesGlobPattern(p, toolName))) return false;
  if (policy.deny && policy.deny.some(p => matchesGlobPattern(p, toolName))) return false;
  return true;
}
