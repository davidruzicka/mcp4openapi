/**
 * DAG Execution Engine for Composite Steps
 *
 * Why: Enables parallel execution of independent composite steps
 * while maintaining correct dependency order.
 *
 * Uses Kahn's algorithm for topological sorting - BFS-based approach
 * that detects cycles and determines execution levels.
 */

import type { CompositeStep } from '../types/profile.js';

/**
 * Execution level containing steps that can run in parallel
 */
export interface ExecutionLevel {
  steps: CompositeStep[];
  stepIndices: number[]; // Original indices for error reporting
}

/**
 * Topological sort result for DAG execution
 */
export interface TopologicalSortResult {
  levels: ExecutionLevel[];
  hasCycles: boolean;
  errorMessage?: string;
}

/**
 * Execute composite steps with DAG-based parallelization
 *
 * Why: Some steps may depend on others (e.g., get MR ID, then fetch comments).
 * Independent steps can run in parallel for better performance.
 */
export class DAGExecutor {
  /**
   * Sort composite steps into execution levels using Kahn's algorithm
   *
   * @param steps Composite steps with optional depends_on
   * @returns Execution levels where each level can run in parallel
   * @throws Error if cycles detected or invalid dependencies
   */
  static topologicalSort(steps: CompositeStep[]): ExecutionLevel[] {
    const result = this.analyzeDAG(steps);
    if (result.hasCycles) {
      throw new Error(`DAG analysis failed: ${result.errorMessage}`);
    }
    return result.levels;
  }

  /**
   * Analyze DAG structure without throwing
   *
   * @param steps Composite steps to analyze
   * @returns Analysis result with levels or error info
   */
  static analyzeDAG(steps: CompositeStep[]): TopologicalSortResult {
    // Build dependency graph and in-degree map
    const graph = new Map<string, string[]>(); // node -> list of dependent nodes
    const inDegree = new Map<string, number>();

    // Initialize all nodes
    for (const step of steps) {
      const node = step.store_as;
      inDegree.set(node, 0);
      if (!graph.has(node)) {
        graph.set(node, []);
      }
    }

    // Build edges and calculate in-degrees
    for (const step of steps) {
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          // Validate dependency exists
          if (!inDegree.has(dep)) {
            return {
              levels: [],
              hasCycles: true,
              errorMessage: `Step '${step.store_as}' depends on '${dep}' but no step produces '${dep}'`
            };
          }

          // Add edge: dep -> step.store_as
          if (!graph.has(dep)) {
            graph.set(dep, []);
          }
          graph.get(dep)!.push(step.store_as);

          // Increase in-degree of dependent step
          inDegree.set(step.store_as, inDegree.get(step.store_as)! + 1);
        }
      }
    }

    // Kahn's algorithm: BFS with in-degree
    const levels: ExecutionLevel[] = [];
    const queue: string[] = [];

    // Start with nodes having in-degree 0 (no dependencies)
    for (const [node, degree] of inDegree) {
      if (degree === 0) {
        queue.push(node);
      }
    }

    // Process queue level by level
    while (queue.length > 0) {
      const currentLevel: CompositeStep[] = [];
      const currentIndices: number[] = [];
      const levelSize = queue.length;

      // Process all nodes at current level (can run in parallel)
      for (let i = 0; i < levelSize; i++) {
        const node = queue.shift()!;

        // Find corresponding step and add to level
        const stepIndex = steps.findIndex(s => s.store_as === node);
        if (stepIndex >= 0) {
          currentLevel.push(steps[stepIndex]);
          currentIndices.push(stepIndex);
        }

        // Decrease in-degree of all dependent nodes
        const neighbors = graph.get(node) || [];
        for (const neighbor of neighbors) {
          const newDegree = inDegree.get(neighbor)! - 1;
          inDegree.set(neighbor, newDegree);

          // If in-degree becomes 0, add to next level
          if (newDegree === 0) {
            queue.push(neighbor);
          }
        }
      }

      // Add level if it contains steps
      if (currentLevel.length > 0) {
        levels.push({ steps: currentLevel, stepIndices: currentIndices });
      }
    }

    // Check for cycles: if not all nodes were processed
    const processedCount = levels.reduce((sum, level) => sum + level.steps.length, 0);
    if (processedCount !== steps.length) {
      // Find unprocessed nodes (part of cycle)
      const processedNodes = new Set<string>();
      for (const level of levels) {
        for (const step of level.steps) {
          processedNodes.add(step.store_as);
        }
      }

      const cycleNodes: string[] = [];
      for (const step of steps) {
        if (!processedNodes.has(step.store_as)) {
          cycleNodes.push(step.store_as);
        }
      }

      return {
        levels: [],
        hasCycles: true,
        errorMessage: `Circular dependency detected involving: ${cycleNodes.join(', ')}`
      };
    }

    return {
      levels,
      hasCycles: false
    };
  }
}


