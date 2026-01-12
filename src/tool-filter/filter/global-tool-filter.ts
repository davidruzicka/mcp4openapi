/**
 * Global tool filter - applies environment-based filtering
 */

import type { ToolDefinition } from '../../types/profile.js';
import type { ToolFilterConfig } from '../types.js';
import type { Logger } from '../../logger.js';
import { FilterEngine } from './filter-engine.js';
import { ExactMatchRule, RegexMatchRule } from './filter-rules.js';

export interface GlobalToolFilterResult {
  allowed: ToolDefinition[];
  removed: ToolDefinition[];
  reasons: Map<string, string[]>;
  summary: {
    originalCount: number;
    allowedCount: number;
    removedCount: number;
  };
}

/**
 * Applies global tool filtering based on environment configuration
 */
export class GlobalToolFilter {
  private engine: FilterEngine;

  constructor(
    private config: ToolFilterConfig,
    private logger: Logger
  ) {
    this.engine = this.buildEngine(config);
  }

  /**
   * Apply filter to tools
   */
  apply(tools: ToolDefinition[]): GlobalToolFilterResult {
    const allowed: ToolDefinition[] = [];
    const removed: ToolDefinition[] = [];
    const reasons = new Map<string, string[]>();

    for (const tool of tools) {
      const result = this.engine.evaluate(tool.name);

      if (result.allowed) {
        allowed.push(tool);
      } else {
        removed.push(tool);
        if (result.reason) {
          reasons.set(tool.name, [result.reason]);
        }
        this.logFiltered(tool, result.reason);
      }
    }

    return {
      allowed,
      removed,
      reasons,
      summary: {
        originalCount: tools.length,
        allowedCount: allowed.length,
        removedCount: removed.length
      }
    };
  }

  /**
   * Build filter engine from config
   */
  private buildEngine(config: ToolFilterConfig): FilterEngine {
    const allowRules = [];
    const denyRules = [];

    // Build allow rules
    if (config.allowList.size > 0) {
      allowRules.push(new ExactMatchRule(config.allowList, 'allow'));
    }

    if (config.allowRegex.length > 0) {
      allowRules.push(new RegexMatchRule(config.allowRegex, 'allow'));
    }

    // Note: CategoryMatchRule requires OperationDetector, which is not available here
    // This will be added in Phase 4 integration

    // Build deny rules
    if (config.denyList.size > 0) {
      denyRules.push(new ExactMatchRule(config.denyList, 'deny'));
    }

    if (config.denyRegex.length > 0) {
      denyRules.push(new RegexMatchRule(config.denyRegex, 'deny'));
    }

    return new FilterEngine(allowRules, denyRules);
  }

  /**
   * Log filtered tool
   */
  private logFiltered(tool: ToolDefinition, reason?: string): void {
    this.logger.info('Tool filtered', {
      filter_source: 'env',
      tool: tool.name,
      action: 'removed',
      reason: reason || 'unknown'
    });
  }
}
