/**
 * Upstream tool sanitizer
 *
 * Validates tool names and descriptions received from upstream MCP servers
 * before exposing them to downstream clients. Drops offending tools with
 * a warning instead of forwarding potentially injected content.
 *
 * Security: drops tools with names outside [a-zA-Z0-9_-] or descriptions
 * containing injection-prone characters (<, >, backtick). Truncates tool
 * names in dropped output to 100 chars + ellipsis (103 chars max) to
 * prevent log injection via maliciously long upstream tool names (D-03, D-04, D-05).
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { sanitizeLogMessage } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type { UpstreamMcpToolPolicy } from '../types/profile.js';

export interface SanitizationResult {
  tools: Tool[];
  dropped: { name: string; reason: string }[];
}

// Data-driven constraints
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DESCRIPTION_FORBIDDEN_CHARS = /[<>`]/;

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
 *   3. Description length <= 2048 (if present)
 *   4. Description contains no <, >, or backtick (if present)
 *
 * Offending tools are dropped and logged. Safe tools pass through unchanged.
 */
export function sanitizeToolList(tools: Tool[], logger?: Logger): SanitizationResult {
  const safe: Tool[] = [];
  const dropped: { name: string; reason: string }[] = [];

  for (const tool of tools) {
    // Guard: upstream may return null or non-object entries (e.g. null items in tools array)
    if (tool === null || typeof tool !== 'object') {
      const safeName = sanitizeLogMessage(truncateName(String(tool)));
      const reason = 'malformed tool definition: entry is not an object';
      dropped.push({ name: safeName, reason });
      logger?.warn('Dropped upstream tool due to sanitization failure', { name: safeName, reason });
      continue;
    }

    let reason: string | undefined;

    // Runtime type guards: upstream may return non-string fields despite SDK types
    if (typeof tool.name !== 'string') {
      reason = 'malformed tool definition: name is not a string';
    } else if (tool.name.length > MAX_TOOL_NAME_LENGTH) {
      reason = 'tool name too long';
    } else if (!TOOL_NAME_PATTERN.test(tool.name)) {
      reason = 'invalid characters in tool name';
    } else if (tool.description !== undefined && typeof tool.description !== 'string') {
      reason = 'malformed tool definition: description is not a string';
    } else if (tool.description && tool.description.length > MAX_DESCRIPTION_LENGTH) {
      reason = 'tool description too long';
    } else if (tool.description && DESCRIPTION_FORBIDDEN_CHARS.test(tool.description)) {
      reason = 'forbidden characters in description';
    } else if (tool.inputSchema && schemaContainsForbiddenChars(tool.inputSchema)) {
      reason = 'forbidden characters in input schema';
    }

    if (reason !== undefined) {
      // Coerce non-string names to string for safe logging
      const nameStr = typeof tool.name === 'string' ? tool.name : String(tool.name);
      const safeName = sanitizeLogMessage(truncateName(nameStr));
      dropped.push({ name: safeName, reason });
      logger?.warn('Dropped upstream tool due to sanitization failure', { name: safeName, reason });
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
function matchesGlobPattern(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const regexStr = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[a-zA-Z0-9_-]*');
  return new RegExp(`^${regexStr}$`).test(name);
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
 */
export function applyProviderToolPolicy(tools: Tool[], policy: UpstreamMcpToolPolicy | undefined): Tool[] {
  if (!policy) return tools;
  const { allow, deny } = policy;
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
