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
 * Apply the profile-level upstream tool policy (allow/deny lists) to a tool list.
 *
 * Semantics:
 *   - allow set: only listed tool names pass
 *   - deny set: listed tool names are rejected
 *   - both set: allow is evaluated first (tool must be in allow AND not in deny)
 *   - neither set: all tools pass
 */
export function applyProviderToolPolicy(tools: Tool[], policy: UpstreamMcpToolPolicy | undefined): Tool[] {
  if (!policy) return tools;
  const allowSet = policy.allow ? new Set(policy.allow) : null;
  const denySet = policy.deny ? new Set(policy.deny) : null;
  return tools.filter((tool) => {
    if (allowSet && !allowSet.has(tool.name)) return false;
    if (denySet && denySet.has(tool.name)) return false;
    return true;
  });
}

/**
 * Check whether a single tool name is permitted by the upstream tool policy.
 * Used in tools/call to enforce allow/deny before forwarding.
 *
 * Uses Array.includes intentionally: policy lists are profile-config-bounded (human-authored,
 * typically < 50 entries) and this function is called once per tools/call. Building a Set
 * inline per call would be strictly worse (O(N) allocation + construction vs O(N) scan on a
 * short array). Pre-caching Sets at profile-load time would be a valid future optimisation
 * but is not warranted at current scale - the bottleneck on the tools/call path is upstream
 * I/O, not these array lookups. applyProviderToolPolicy uses Sets because it iterates the
 * full tool list (O(M*N) without Set vs O(M) with Set); that trade-off does not apply here.
 */
export function isToolAllowedByProviderPolicy(toolName: string, policy: UpstreamMcpToolPolicy | undefined): boolean {
  if (!policy) return true;
  if (policy.allow && !policy.allow.includes(toolName)) return false;
  if (policy.deny && policy.deny.includes(toolName)) return false;
  return true;
}
