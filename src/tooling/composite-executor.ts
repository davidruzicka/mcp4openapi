/**
 * Composite action executor for chaining API calls
 * 
 * Why: Reduces roundtrips by fetching related data in sequence (e.g., MR + comments).
 * Aggregates results into single JSON structure as defined by store_as paths.
 */

import type { CompositeStep } from '../types/profile.js';
import type { HttpClient } from '../transport/interceptors.js';
import type { OperationInfo } from '../types/openapi.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { DAGExecutor, type ExecutionLevel } from './dag-executor.js';
import { isSafePropertyName } from '../validation/validation-utils.js';

export interface CompositeResult {
  data: Record<string, unknown>;
  completed_steps: number;
  total_steps: number;
  errors?: StepError[];
}

export interface StepError {
  step_index: number;
  step_call: string;
  error: string;
  timestamp: string;
}

export class CompositeExecutor {
  constructor(
    private parser: OpenAPIParser,
    private httpClient?: HttpClient,
    private parameterAliases: Record<string, string[]> = {}
  ) {}

  /**
   * Execute a series of API calls and merge results
   *
   * Why parallel: Steps may have dependencies, but independent steps can run concurrently.
   * Uses DAG analysis to determine safe parallelization while maintaining correctness.
   *
   * Supports partial results: If allowPartial=true, continues after errors and returns
   * what was completed. Useful for composite actions where some data is better than none.
   */
  async execute(
    steps: CompositeStep[],
    args: Record<string, unknown>,
    allowPartial: boolean = false,
    httpClient?: HttpClient
  ): Promise<CompositeResult> {
    // Analyze DAG and get execution levels
    const executionLevels = DAGExecutor.topologicalSort(steps);

    const result: Record<string, unknown> = {};
    const errors: StepError[] = [];
    let completedSteps = 0;

    // Execute level by level (each level can run in parallel)
    for (const level of executionLevels) {
      // Execute all steps in current level concurrently
      const levelPromises = level.steps.map((step, levelIndex) =>
        this.executeStep(step, level.stepIndices[levelIndex], args, httpClient)
      );

      // Wait for all steps in this level to complete
      const levelResults = await Promise.allSettled(levelPromises);

      // Process results
      for (let i = 0; i < levelResults.length; i++) {
        const promiseResult = levelResults[i];
        const step = level.steps[i];
        const originalStepIndex = level.stepIndices[i];

        if (promiseResult.status === 'fulfilled') {
          // Step completed successfully
          const response = promiseResult.value;
          this.storeResult(result, step.store_as, response.body);
          completedSteps++;
        } else {
          // Step failed
          const error = promiseResult.reason;
          const stepError: StepError = {
            step_index: originalStepIndex,
            step_call: step.call,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          };

          errors.push(stepError);

          // Store error in result for debugging
          this.storeResult(result, `${step.store_as}_error`, stepError);

          if (!allowPartial) {
            throw new Error(
              `Composite step ${originalStepIndex + 1}/${steps.length} failed: ${stepError.error}\n` +
              `Completed steps: ${completedSteps}\n` +
              `Failed step: ${step.call}`
            );
          }
        }
      }
    }

    return {
      data: result,
      completed_steps: completedSteps,
      total_steps: steps.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Execute single composite step (extracted for parallel execution)
   *
   * @param step The composite step to execute
   * @param stepIndex Original index for error reporting
   * @param args Arguments for parameter substitution
   * @param httpClient Optional HTTP client override
   * @returns Promise resolving to HTTP response
   */
  private async executeStep(
    step: CompositeStep,
    stepIndex: number,
    args: Record<string, unknown>,
    httpClient?: HttpClient
  ): Promise<{ body: unknown }> {
    const { method, path, operation } = this.parseCall(step.call);

    if (!operation) {
      throw new Error(`Operation not found for call: ${step.call}`);
    }

    // Substitute path parameters from args
    const resolvedPath = this.resolvePath(path, args);

    // Execute request
    const client = httpClient || this.httpClient;
    if (!client) {
      throw new Error('HTTP client not provided');
    }

    const response = await client.request(method, resolvedPath, {
      params: this.extractQueryParams(operation, args),
      operationId: operation.operationId,
    });

    return response;
  }

  /**
   * Parse composite step call syntax
   *
   * Format: "GET /projects/{id}/merge_requests/{iid}"
   */
  private parseCall(call: string): { method: string; path: string; operation: OperationInfo | undefined } {
    const [method, path] = call.split(' ');
    const pathInfo = this.parser.getPath(path);
    const operation = pathInfo?.operations[method.toLowerCase()];

    return { method, path, operation };
  }

  /**
   * Resolve path template with actual values
   * 
   * Example: "/projects/{id}" + {id: "123"} => "/projects/123"
   * Supports parameter_aliases: {project_id: "123"} can map to {id} if configured
   */
  private resolvePath(template: string, args: Record<string, unknown>): string {
    return template.replace(/\{(\w+)\}/g, (_, key) => {
      // Try direct match first
      if (args[key] !== undefined) {
        return String(args[key]);
      }

      // Try aliases from profile
      const possibleAliases = this.parameterAliases[key] || [];
      for (const alias of possibleAliases) {
        if (args[alias] !== undefined) {
          return String(args[alias]);
        }
      }

      throw new Error(
        `Missing path parameter: ${key}` +
        (possibleAliases.length > 0 ? `. Tried aliases: ${possibleAliases.join(', ')}` : '')
      );
    });
  }

  /**
   * Extract query parameters from args based on operation definition
   */
  private extractQueryParams(operation: OperationInfo, args: Record<string, unknown>): Record<string, string | string[]> {
    const params: Record<string, string | string[]> = {};

    for (const param of operation.parameters) {
      if (param.in === 'query' && args[param.name] !== undefined) {
        const value = args[param.name];
        // Pass arrays as-is for HttpClient serialization
        if (Array.isArray(value)) {
          params[param.name] = value.map(String);
        } else {
          params[param.name] = String(value);
        }
      }
    }

    return params;
  }

  /**
   * Store value at JSONPath-like location
   * 
   * Why nested: Allows semantic structure (comments belong under merge_request object).
   * 
   * Examples:
   * - "merge_request" => { merge_request: value }
   * - "merge_request.comments" => { merge_request: { comments: value } }
   * 
   * Validates path navigation to prevent overwriting non-object values.
   */
  private storeResult(target: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let current = target as Record<string, unknown>;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      
      // Prevent prototype pollution
      if (!isSafePropertyName(part)) {
        throw new Error(`Invalid property name in path: ${part}`);
      }
      
      const existing = current[part];
      
      // Validate we can navigate through this path
      if (existing !== undefined && (typeof existing !== 'object' || existing === null)) {
        throw new Error(
          `Cannot store at path '${path}': ` +
          `'${parts.slice(0, i + 1).join('.')}' is ${typeof existing}, not an object`
        );
      }
      
      if (!current[part]) {
        // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    const finalKey = parts[parts.length - 1];
    if (!isSafePropertyName(finalKey)) {
      throw new Error(`Invalid property name in path: ${finalKey}`);
    }
    current[finalKey] = value;
  }
}

