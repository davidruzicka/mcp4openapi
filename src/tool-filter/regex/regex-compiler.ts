/**
 * Regex compiler with auto-anchoring support
 */

import type { CompiledRegex } from '../types.js';
import type { RegexValidator } from './regex-validator.js';
import { InvalidRegexError } from '../errors.js';
import { MAX_TOOL_FILTER_NAME_LENGTH } from '../constants.js';

/**
 * Compiled regex implementation
 */
class CompiledRegexImpl implements CompiledRegex {
  constructor(
    public readonly regex: RegExp,
    public readonly original: string,
    public readonly anchored: string
  ) {}

  test(value: string): boolean {
    if (value.length > MAX_TOOL_FILTER_NAME_LENGTH) {
      return false;
    }

    return this.regex.test(value);
  }
}

/**
 * Compiles regex patterns with validation and auto-anchoring
 */
export class RegexCompiler {
  constructor(private validator: RegexValidator) {}

  /**
   * Compile a regex pattern with validation and auto-anchoring
   * @throws InvalidRegexError if pattern is invalid or unsafe
   */
  compile(pattern: string, context: string): CompiledRegex {
    const trimmed = pattern.trim();
    const anchored = this.autoAnchor(trimmed);
    
    // Validate for safety
    const validation = this.validator.validate(anchored);
    if (!validation.valid) {
      throw new InvalidRegexError(context, pattern, validation.error!);
    }

    // Try to compile
    try {
      const regex = new RegExp(anchored);
      return new CompiledRegexImpl(regex, pattern, anchored);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidRegexError(context, pattern, message);
    }
  }

  /**
   * Auto-anchor pattern with ^ and $ if not already present
   */
  private autoAnchor(pattern: string): string {
    const withStart = pattern.startsWith('^') ? pattern : `^${pattern}`;
    const withEnd = withStart.endsWith('$') ? withStart : `${withStart}$`;
    return withEnd;
  }
}
