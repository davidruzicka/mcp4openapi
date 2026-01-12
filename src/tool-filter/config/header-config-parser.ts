/**
 * Header config parser for session-based filtering
 */

import type { SessionToolFilterRequest, CompiledRegex } from '../types.js';
import type { RegexCompiler } from '../regex/regex-compiler.js';
import { ValidationError, ConfigurationError } from '../errors.js';

const MAX_HEADER_ENTRY_LENGTH = 255;
const DEFAULT_MAX_ENTRIES = 100;

/**
 * Parses X-Mcp4-Tools header for session filtering
 */
export class HeaderConfigParser {
  constructor(private compiler: RegexCompiler) {}

  /**
   * Parse header value into session filter request
   */
  parse(headerValue: string): SessionToolFilterRequest {
    const normalized = this.normalizeHeader(headerValue);
    if (!normalized) {
      return this.emptyRequest();
    }

    const parts = this.splitAndValidate(normalized);
    const parsed = this.parseParts(parts);

    return {
      exactNames: parsed.exactNames,
      regexPatterns: parsed.regexPatterns,
      normalizedHeader: normalized,
      rawEntries: parts,
      hasRules: parts.length > 0
    };
  }

  /**
   * Normalize header value
   */
  private normalizeHeader(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '';
  }

  /**
   * Split and validate header parts
   */
  private splitAndValidate(value: string): string[] {
    const parts = value.split(',').map(p => p.trim()).filter(Boolean);

    const maxEntries = this.getMaxEntries();
    if (parts.length > maxEntries) {
      throw new ValidationError(
        `X-Mcp4-Tools contains too many entries (${parts.length} > ${maxEntries}). ` +
        `Reduce to ${maxEntries} or configure MCP4_TOOL_FILTER_SESSION_MAX_TOOLS.`
      );
    }

    // Validate entry lengths
    for (const part of parts) {
      if (part.length > MAX_HEADER_ENTRY_LENGTH) {
        throw new ValidationError(
          `X-Mcp4-Tools entry exceeds ${MAX_HEADER_ENTRY_LENGTH} chars: ` +
          `'${part}' (${part.length} chars)`
        );
      }
    }

    return parts;
  }

  /**
   * Parse header parts into structured data
   */
  private parseParts(parts: string[]): ParsedParts {
    const exactNames = new Set<string>();
    const regexPatterns: CompiledRegex[] = [];

    for (const part of parts) {
      if (part.startsWith('_allow_')) {
        throw new ValidationError(
          'X-Mcp4-Tools does not support _allow_* keywords. Use explicit tool names or regex: patterns. (Did you mean to use X-Mcp4-Params?)'
        );
      } else if (part.startsWith('regex:')) {
        const pattern = part.slice('regex:'.length).trim();
        if (!pattern) {
          throw new ValidationError('X-Mcp4-Tools regex entry is empty');
        }
        regexPatterns.push(this.compiler.compile(pattern, 'X-Mcp4-Tools'));
      } else {
        exactNames.add(part.normalize('NFC'));
      }
    }

    return { exactNames, regexPatterns };
  }

  /**
   * Get max entries from env var
   */
  private getMaxEntries(): number {
    const raw = process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS;
    if (!raw) {
      return DEFAULT_MAX_ENTRIES;
    }

    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      throw new ConfigurationError(
        `Invalid MCP4_TOOL_FILTER_SESSION_MAX_TOOLS: '${raw}' (must be positive integer)`
      );
    }

    return parsed;
  }

  /**
   * Create empty request
   */
  private emptyRequest(): SessionToolFilterRequest {
    return {
      exactNames: new Set(),
      regexPatterns: [],
      normalizedHeader: '',
      rawEntries: [],
      hasRules: false
    };
  }
}

interface ParsedParts {
  exactNames: Set<string>;
  regexPatterns: CompiledRegex[];
}
