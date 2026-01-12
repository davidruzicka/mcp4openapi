/**
 * Filter engine - orchestrates filter rules
 */

import type { FilterRule } from './filter-rules.js';

/**
 * Filter result
 */
export class FilterResult {
  private constructor(
    public readonly allowed: boolean,
    public readonly reason?: string
  ) {}

  static allowed(reason?: string): FilterResult {
    return new FilterResult(true, reason);
  }

  static denied(reason: string): FilterResult {
    return new FilterResult(false, reason);
  }
}

/**
 * Filter engine that evaluates tools against rules
 */
export class FilterEngine {
  constructor(
    private allowRules: FilterRule[],
    private denyRules: FilterRule[]
  ) {}

  /**
   * Evaluate tool name against rules
   * 
   * Rule precedence:
   * 1. Deny rules (if any match, deny immediately)
   * 2. If no allow rules, allow by default
   * 3. Allow rules (must match at least one)
   */
  evaluate(toolName: string): FilterResult {
    // Normalize tool name (Unicode NFC)
    const normalized = toolName.normalize('NFC');

    // Check deny rules first (precedence)
    for (const rule of this.denyRules) {
      if (rule.matches(normalized)) {
        return FilterResult.denied(rule.getReason());
      }
    }

    // If no allow rules, allow by default
    if (this.allowRules.length === 0) {
      return FilterResult.allowed();
    }

    // Check allow rules
    for (const rule of this.allowRules) {
      if (rule.matches(normalized)) {
        return FilterResult.allowed(rule.getReason());
      }
    }

    // No allow rule matched
    return FilterResult.denied('no_allow_match');
  }
}
