/**
 * Filter rules - Strategy pattern for tool filtering
 */

import type { CompiledRegex } from '../types.js';
import type { ToolDefinition } from '../../types/profile.js';
import type { OperationDetector } from '../operation/operation-detector.js';

/**
 * Filter rule interface
 */
export interface FilterRule {
  matches(toolNameOrTool: string | ToolDefinition): boolean;
  getReason(): string;
}

/**
 * Exact name match rule
 */
export class ExactMatchRule implements FilterRule {
  constructor(
    private names: Set<string>,
    private type: 'allow' | 'deny'
  ) {}

  matches(toolNameOrTool: string | ToolDefinition): boolean {
    const toolName = typeof toolNameOrTool === 'string' ? toolNameOrTool : toolNameOrTool.name;
    return this.names.has(toolName);
  }

  getReason(): string {
    return `${this.type}_list`;
  }
}

/**
 * Regex pattern match rule
 */
export class RegexMatchRule implements FilterRule {
  constructor(
    private patterns: CompiledRegex[],
    private type: 'allow' | 'deny'
  ) {}

  matches(toolNameOrTool: string | ToolDefinition): boolean {
    const toolName = typeof toolNameOrTool === 'string' ? toolNameOrTool : toolNameOrTool.name;
    return this.patterns.some(pattern => pattern.test(toolName));
  }

  getReason(): string {
    return `${this.type}_regex`;
  }
}

/**
 * Category match rule - matches based on operation categories
 */
export class CategoryMatchRule implements FilterRule {
  constructor(
    private allowedCategories: Set<'list' | 'read'>,
    private detector: OperationDetector
  ) {}

  matches(toolNameOrTool: string | ToolDefinition): boolean {
    // This rule only works with ToolDefinition objects
    if (typeof toolNameOrTool === 'string') {
      return false;
    }

    const tool = toolNameOrTool;
    const categories = this.detector.detectCategories(tool);

    // Check if tool matches allowed categories
    const hasListAndRead = this.allowedCategories.has('list') && this.allowedCategories.has('read');
    
    if (hasListAndRead) {
      // If both list and read are allowed, accept tools that are list-only, read-only, or both
      // But NOT tools that have modify operations
      return categories.isList || categories.isRead;
    }

    // Single category - must match exactly (no mixing)
    if (this.allowedCategories.has('list')) {
      return categories.isList && !categories.isRead;
    }

    if (this.allowedCategories.has('read')) {
      return categories.isRead && !categories.isList;
    }

    return false;
  }

  getReason(): string {
    const cats = Array.from(this.allowedCategories).sort();
    return `allow_categories:${cats.join(',')}`;
  }
}
