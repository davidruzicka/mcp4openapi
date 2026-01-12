/**
 * Regex pattern validator with ReDoS protection
 */

import type { ValidationResult } from '../types.js';

const DEFAULT_MAX_LENGTH = 100;

/**
 * Validates regex patterns for ReDoS vulnerabilities
 */
export class RegexValidator {
  private readonly maxLength: number;

  constructor(maxLength: number = DEFAULT_MAX_LENGTH) {
    this.maxLength = maxLength;
  }

  /**
   * Validate regex pattern for safety
   */
  validate(pattern: string): ValidationResult {
    // Check length
    if (pattern.length > this.maxLength) {
      return {
        valid: false,
        error: `Pattern exceeds ${this.maxLength} characters`
      };
    }

    // Check for nested quantifiers (ReDoS risk)
    if (this.hasNestedQuantifiers(pattern)) {
      return {
        valid: false,
        error: 'Pattern contains nested quantifiers'
      };
    }

    // Check for ambiguous alternation (ReDoS risk)
    if (this.hasAmbiguousAlternation(pattern)) {
      return {
        valid: false,
        error: 'Pattern contains alternation with quantifier'
      };
    }

    return { valid: true };
  }

  /**
   * Detect nested quantifiers like (a+)+ which cause exponential backtracking
   */
  private hasNestedQuantifiers(pattern: string): boolean {
    // Match: group with quantifier inside, followed by quantifier outside
    // Example: (a+)+ or (x*)* or (y{2,3})+
    const nestedPattern = /\((?:[^\\]|\\.)*?[+*{](?:[^\\]|\\.)*?\)[+*{]/;
    return nestedPattern.test(pattern);
  }

  /**
   * Detect alternation groups with quantifiers which can cause backtracking
   */
  private hasAmbiguousAlternation(pattern: string): boolean {
    // Match: group with alternation (|), followed by quantifier
    // Example: (a|aa)+ or (foo|foobar)*
    const alternationPattern = /\((?:[^\\]|\\.)*?\|(?:[^\\]|\\.)*?\)[+*{]/;
    return alternationPattern.test(pattern);
  }
}
