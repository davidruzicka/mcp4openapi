/**
 * Operation resolver - resolves operations from OpenAPI spec
 */

import type { OpenAPIParser } from '../../openapi-parser.js';
import type { OperationInfo } from '../../types/openapi.js';
import type { OperationResolver } from '../types.js';

/**
 * Resolves operations from OpenAPI specification
 */
export class OpenAPIOperationResolver implements OperationResolver {
  constructor(private parser: OpenAPIParser) {}

  /**
   * Get operation by operation ID
   */
  getOperationById(operationId: string): OperationInfo | undefined {
    return this.parser.getOperation(operationId);
  }

  /**
   * Get operation from call string (e.g., "GET /users/{id}")
   */
  getOperationForCall(call: string): OperationInfo | undefined {
    const [method, path] = call.split(' ', 2);
    if (!method || !path) {
      return undefined;
    }
    
    const pathInfo = this.parser.getPath(path);
    if (!pathInfo) {
      return undefined;
    }
    
    return pathInfo.operations[method.toLowerCase()];
  }
}
