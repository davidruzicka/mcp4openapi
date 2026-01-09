/**
 * Operation classifier - categorizes operations as list/read/modify
 */

import type { OperationInfo } from '../../types/openapi.js';
import type { OperationCategory } from '../types.js';

/**
 * Classifies operations into categories based on HTTP method and parameters
 */
export class OperationClassifier {
  /**
   * Classify an operation as list, read, or modify
   * 
   * Rules:
   * - GET without path params → list
   * - GET with path params → read
   * - All other methods → modify
   */
  classify(operation: OperationInfo): OperationCategory {
    const method = operation.method.toLowerCase();
    
    if (method !== 'get') {
      return 'modify';
    }
    
    // GET operation - check for path parameters
    const hasPathParams = operation.parameters.some(param => param.in === 'path');
    return hasPathParams ? 'read' : 'list';
  }
}
