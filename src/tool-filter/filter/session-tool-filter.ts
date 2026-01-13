/**
 * Session tool filter - applies per-session filtering
 */

import type { ToolDefinition } from '../../types/profile.js';
import type { SessionToolFilterRequest } from '../types.js';
import type { OperationDetector } from '../operation/operation-detector.js';
import { FilterEngine } from './filter-engine.js';
import { ExactMatchRule, RegexMatchRule, CategoryMatchRule } from './filter-rules.js';

export interface SessionToolFilterResult {
  allowedToolNames: Set<string>;
  reasons: Map<string, string[]>;
  normalizedHeader: string;
}

/**
 * Applies session-based tool filtering from X-Mcp4-Tools header
 */
export class SessionToolFilter {
  private engine: FilterEngine;

  constructor(
    private request: SessionToolFilterRequest,
    private detector?: OperationDetector
  ) {
    this.engine = this.buildEngine(request);
  }

  /**
   * Apply filter to tools
   */
  apply(tools: ToolDefinition[]): SessionToolFilterResult {
    const allowedToolNames = new Set<string>();
    const reasons = new Map<string, string[]>();

    // If no rules, allow all
    if (!this.request.hasRules) {
      for (const tool of tools) {
        allowedToolNames.add(tool.name);
      }
      return {
        allowedToolNames,
        reasons,
        normalizedHeader: this.request.normalizedHeader
      };
    }

    // Apply rules
    for (const tool of tools) {
      const result = this.engine.evaluateTool(tool);

      if (result.allowed) {
        allowedToolNames.add(tool.name);
      } else {
        reasons.set(tool.name, ['session_filter']);
      }
    }

    return {
      allowedToolNames,
      reasons,
      normalizedHeader: this.request.normalizedHeader
    };
  }

  /**
   * Build filter engine from request
   */
  private buildEngine(request: SessionToolFilterRequest): FilterEngine {
    const allowRules = [];

    if (request.exactNames.size > 0) {
      allowRules.push(new ExactMatchRule(request.exactNames, 'allow'));
    }

    if (request.regexPatterns.length > 0) {
      allowRules.push(new RegexMatchRule(request.regexPatterns, 'allow'));
    }

    if (request.allowCategories.size > 0) {
      if (!this.detector) {
        throw new Error(
          'X-Mcp4-Tools includes _allow_list/_allow_read but OperationDetector is not available. ' +
          'Category-based session tool filtering requires OpenAPI parser.'
        );
      }
      allowRules.push(new CategoryMatchRule(request.allowCategories, this.detector));
    }

    return new FilterEngine(allowRules, []);
  }
}
