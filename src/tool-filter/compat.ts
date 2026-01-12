/**
 * Compatibility functions for legacy code
 * 
 * These functions provide backward-compatible API for code that hasn't
 * been migrated to use the new modular architecture yet.
 */

import type { ToolDefinition } from '../types/profile.js';
import type { SessionToolFilterRequest } from './types.js';
import { HeaderConfigParser } from './config/header-config-parser.js';
import { RegexCompiler } from './regex/regex-compiler.js';
import { RegexValidator } from './regex/regex-validator.js';
import { SessionToolFilter as SessionToolFilterClass } from './filter/session-tool-filter.js';

// Legacy SessionToolFilter type for compatibility
export interface SessionToolFilter {
  allowedToolNames: Set<string>;
  reasons: Map<string, string[]>;
  patterns: { allow: RegExp[] };
  normalizedHeader: string;
}

/**
 * Normalize tool filter header value
 * 
 * @param value - Raw header value
 * @returns Normalized value or undefined if empty
 */
export function normalizeToolFilterHeaderValue(value?: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  
  return trimmed;
}

/**
 * Parse session tool filter header
 * 
 * Legacy wrapper around HeaderConfigParser for backward compatibility.
 * New code should use HeaderConfigParser directly.
 * 
 * @param headerValue - Header value to parse
 * @returns Parsed session filter request
 */
export function parseSessionToolFilterHeader(headerValue: string): SessionToolFilterRequest {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);
  const parser = new HeaderConfigParser(compiler);
  
  return parser.parse(headerValue);
}

/**
 * Apply session tool filter
 * 
 * Legacy function for backward compatibility.
 * New code should use SessionToolFilter class directly.
 * 
 * @param tools - Tools to filter
 * @param request - Filter request from header
 * @param resolver - Operation resolver (optional, for legacy compatibility)
 * @returns Session filter result
 */
export function applySessionToolFilter(
  tools: ToolDefinition[],
  request: SessionToolFilterRequest,
  resolver?: { getOperationById?: (id: string) => any; getOperationForCall?: (call: string) => any }
): SessionToolFilter {
  void resolver;
  const filter = new SessionToolFilterClass(request);
  const result = filter.apply(tools);
  
  // Convert to legacy format
  return {
    allowedToolNames: result.allowedToolNames,
    reasons: result.reasons,
    patterns: { allow: [] }, // Not tracked in new architecture
    normalizedHeader: request.normalizedHeader
  };
}
