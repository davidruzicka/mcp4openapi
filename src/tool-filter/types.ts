/**
 * Shared types for tool-filter module
 */

import type { ToolDefinition } from '../types/profile.js';
import type { OperationInfo } from '../types/openapi.js';

/**
 * Result of regex pattern validation
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Compiled regex with metadata
 */
export interface CompiledRegex {
  readonly regex: RegExp;
  readonly original: string;
  readonly anchored: string;
  test(value: string): boolean;
}

/**
 * Tool filter configuration from environment variables
 */
export interface ToolFilterConfig {
  allowList: Set<string>;
  denyList: Set<string>;
  allowRegex: CompiledRegex[];
  denyRegex: CompiledRegex[];
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

/**
 * Result of applying tool filter
 */
export interface ToolFilterResult {
  allowed: ToolDefinition[];
  removed: ToolDefinition[];
  reasons: Map<string, string[]>;
}

/**
 * Session tool filter request (parsed from header)
 */
export interface SessionToolFilterRequest {
  exactNames: Set<string>;
  regexPatterns: CompiledRegex[];
  normalizedHeader: string;
  rawEntries: string[];
  hasRules: boolean;
}

/**
 * Session tool filter result
 */
export interface SessionToolFilter {
  allowedToolNames: Set<string>;
  reasons: Map<string, string[]>;
  patterns: { allow: CompiledRegex[] };
  normalizedHeader: string;
}

/**
 * Operation resolver interface (strong contract)
 */
export interface OperationResolver {
  getOperationById(operationId: string): OperationInfo | undefined;
  getOperationForCall(call: string): OperationInfo | undefined;
}

/**
 * Operation category
 */
export type OperationCategory = 'list' | 'read' | 'modify';

/**
 * Tool categories detection result
 */
export interface ToolCategories {
  isList: boolean;
  isRead: boolean;
}
