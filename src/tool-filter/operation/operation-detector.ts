/**
 * Operation detector - detects tool categories
 */

import type { ToolDefinition } from '../../types/profile.js';
import type { OperationResolver, ToolCategories } from '../types.js';
import type { OperationClassifier } from './operation-classifier.js';

/**
 * Detects categories (list/read) for tools
 */
export class OperationDetector {
  constructor(
    private classifier: OperationClassifier,
    private resolver: OperationResolver
  ) {}

  /**
   * Detect whether tool is list-only and/or read-only
   * 
   * For simple tools: checks all operations
   * For composite tools: ALL steps must be same category (strict)
   */
  detectCategories(tool: ToolDefinition): ToolCategories {
    if (tool.composite && tool.steps) {
      return this.detectCompositeCategories(tool);
    }

    if (tool.operations) {
      return this.detectSimpleToolCategories(tool);
    }

    return { isList: false, isRead: false };
  }

  /**
   * Detect composite tool categories (strict: ALL steps must be same)
   */
  private detectCompositeCategories(tool: ToolDefinition): ToolCategories {
    if (!tool.steps || tool.steps.length === 0) {
      return { isList: false, isRead: false };
    }

    let hasAny = false;
    let allList = true;
    let allRead = true;

    for (const step of tool.steps) {
      const operation = this.resolver.getOperationForCall(step.call);
      if (!operation) {
        // Can't resolve - treat as unsafe (modify)
        allList = false;
        allRead = false;
        continue;
      }

      hasAny = true;
      const category = this.classifier.classify(operation);

      if (category !== 'list') {
        allList = false;
      }
      if (category !== 'read') {
        allRead = false;
      }
    }

    return {
      isList: hasAny && allList,
      isRead: hasAny && allRead
    };
  }

  /**
   * Detect simple tool categories
   */
  private detectSimpleToolCategories(tool: ToolDefinition): ToolCategories {
    if (!tool.operations) {
      return { isList: false, isRead: false };
    }

    let isList = false;
    let isRead = false;

    for (const [action, operationId] of Object.entries(tool.operations)) {
      if (typeof operationId !== 'string') {
        continue;
      }

      // Try to resolve operation
      const operation = this.resolver.getOperationById(operationId);
      if (operation) {
        const category = this.classifier.classify(operation);
        if (category === 'list') {
          isList = true;
        }
        if (category === 'read') {
          isRead = true;
        }
        continue;
      }

      // Fallback: detect from action name
      const actionLower = action.toLowerCase();
      if (actionLower === 'list' || actionLower === 'search') {
        isList = true;
      }
      if (actionLower === 'get' || actionLower === 'read') {
        isRead = true;
      }
    }

    return { isList, isRead };
  }
}
