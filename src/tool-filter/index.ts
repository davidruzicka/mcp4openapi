/**
 * Tool Filter Module - Public API
 * 
 * This module provides tool filtering functionality for MCP servers.
 */

// Regex validation and compilation
export { RegexValidator } from './regex/regex-validator.js';
export { RegexCompiler } from './regex/regex-compiler.js';

// Operation classification
export { OperationClassifier } from './operation/operation-classifier.js';
export { OpenAPIOperationResolver } from './operation/operation-resolver.js';
export { OperationDetector } from './operation/operation-detector.js';

// Filter engine and rules
export { FilterEngine, FilterResult } from './filter/filter-engine.js';
export { ExactMatchRule, RegexMatchRule, CategoryMatchRule } from './filter/filter-rules.js';
export type { FilterRule } from './filter/filter-rules.js';

// Filter implementations
export { GlobalToolFilter } from './filter/global-tool-filter.js';
export type { GlobalToolFilterResult } from './filter/global-tool-filter.js';
export { SessionToolFilter } from './filter/session-tool-filter.js';
export type { SessionToolFilterResult } from './filter/session-tool-filter.js';

// Config parsers
export { EnvConfigParser } from './config/env-config-parser.js';
export { HeaderConfigParser } from './config/header-config-parser.js';

// Integration service
export { ToolFilterService } from './integration/tool-filter-service.js';
export {
  createToolFilterService,
  type CreateToolFilterServiceOptions,
} from './integration/tool-filter-service-factory.js';

// Utilities
export { normalizeToolName } from './utils.js';

// Compatibility functions (for legacy code)
export { 
  normalizeToolFilterHeaderValue, 
  parseSessionToolFilterHeader,
  applySessionToolFilter,
  type SessionToolFilter as SessionToolFilterCompat
} from './compat.js';

// Types
export type {
  ValidationResult,
  CompiledRegex,
  ToolFilterConfig,
  ToolFilterResult,
  SessionToolFilterRequest,
  SessionToolFilter as SessionToolFilterLegacy,
  OperationResolver,
  OperationCategory,
  ToolFilterCategory,
  ToolCategories
} from './types.js';

// Errors
export { InvalidRegexError, ConfigurationError, ValidationError } from './errors.js';
