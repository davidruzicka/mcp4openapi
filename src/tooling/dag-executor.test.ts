/**
 * DAG Executor tests
 */

import { describe, it, expect } from 'vitest';
import { DAGExecutor } from './dag-executor.js';
import type { CompositeStep } from '../types/profile.js';

describe('DAGExecutor', () => {
  describe('topologicalSort', () => {
    it('sorts linear dependencies', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a' },
        { call: 'GET /b', store_as: 'b', depends_on: ['a'] },
        { call: 'GET /c', store_as: 'c', depends_on: ['b'] },
      ];

      const levels = DAGExecutor.topologicalSort(steps);

      expect(levels).toHaveLength(3);
      expect(levels[0].steps).toHaveLength(1);
      expect(levels[0].steps[0].store_as).toBe('a');
      expect(levels[1].steps).toHaveLength(1);
      expect(levels[1].steps[0].store_as).toBe('b');
      expect(levels[2].steps).toHaveLength(1);
      expect(levels[2].steps[0].store_as).toBe('c');
    });

    it('parallelizes independent steps', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a' },
        { call: 'GET /b', store_as: 'b', depends_on: ['a'] },
        { call: 'GET /c', store_as: 'c', depends_on: ['a'] },
        { call: 'GET /d', store_as: 'd', depends_on: ['b', 'c'] },
      ];

      const levels = DAGExecutor.topologicalSort(steps);

      expect(levels).toHaveLength(3);
      expect(levels[0].steps).toHaveLength(1); // [a]
      expect(levels[0].steps[0].store_as).toBe('a');
      expect(levels[1].steps).toHaveLength(2); // [b, c] - parallel
      expect(levels[1].steps.map(s => s.store_as)).toContain('b');
      expect(levels[1].steps.map(s => s.store_as)).toContain('c');
      expect(levels[2].steps).toHaveLength(1); // [d]
      expect(levels[2].steps[0].store_as).toBe('d');
    });

    it('handles steps without dependencies', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a' },
        { call: 'GET /b', store_as: 'b' },
        { call: 'GET /c', store_as: 'c', depends_on: ['a'] },
      ];

      const levels = DAGExecutor.topologicalSort(steps);

      expect(levels).toHaveLength(2);
      expect(levels[0].steps).toHaveLength(2); // [a, b] - parallel
      expect(levels[0].steps.map(s => s.store_as)).toContain('a');
      expect(levels[0].steps.map(s => s.store_as)).toContain('b');
      expect(levels[1].steps).toHaveLength(1); // [c]
      expect(levels[1].steps[0].store_as).toBe('c');
    });

    it('throws on circular dependencies', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a', depends_on: ['c'] },
        { call: 'GET /b', store_as: 'b', depends_on: ['a'] },
        { call: 'GET /c', store_as: 'c', depends_on: ['b'] },
      ];

      expect(() => DAGExecutor.topologicalSort(steps)).toThrow('Circular dependency detected');
    });

    it('throws on self-dependency', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a', depends_on: ['a'] },
      ];

      expect(() => DAGExecutor.topologicalSort(steps)).toThrow('Circular dependency detected');
    });

    it('throws on missing dependency', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a', depends_on: ['nonexistent'] },
      ];

      expect(() => DAGExecutor.topologicalSort(steps)).toThrow('depends on \'nonexistent\' but no step produces \'nonexistent\'');
    });
  });

  describe('analyzeDAG', () => {
    it('returns analysis result without throwing', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a', depends_on: ['c'] },
        { call: 'GET /b', store_as: 'b', depends_on: ['a'] },
        { call: 'GET /c', store_as: 'c', depends_on: ['b'] },
      ];

      const result = DAGExecutor.analyzeDAG(steps);

      expect(result.hasCycles).toBe(true);
      expect(result.errorMessage).toContain('Circular dependency detected');
      expect(result.errorMessage).toContain('involving:');
      // All nodes are in the cycle
      expect(result.errorMessage).toMatch(/a|b|c/);
      expect(result.levels).toHaveLength(0);
    });

    it('returns successful analysis', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a' },
        { call: 'GET /b', store_as: 'b', depends_on: ['a'] },
      ];

      const result = DAGExecutor.analyzeDAG(steps);

      expect(result.hasCycles).toBe(false);
      expect(result.errorMessage).toBeUndefined();
      expect(result.levels).toHaveLength(2);
    });

    it('reports cycles when some nodes are processed but a remaining cycle exists', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a' },
        { call: 'GET /b', store_as: 'b', depends_on: ['a', 'c'] },
        { call: 'GET /c', store_as: 'c', depends_on: ['b'] },
      ];

      const result = DAGExecutor.analyzeDAG(steps);
      expect(result.hasCycles).toBe(true);
      expect(result.errorMessage).toContain('Circular dependency detected');
      expect(result.errorMessage).toContain('b');
      expect(result.errorMessage).toContain('c');
    });

    it('handles multiple steps depending on the same dependency', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /root', store_as: 'root' },
        { call: 'GET /child1', store_as: 'child1', depends_on: ['root'] },
        { call: 'GET /child2', store_as: 'child2', depends_on: ['root'] },
        { call: 'GET /child3', store_as: 'child3', depends_on: ['root'] },
      ];

      const result = DAGExecutor.analyzeDAG(steps);

      expect(result.hasCycles).toBe(false);
      expect(result.levels).toHaveLength(2);
      // First level: root
      expect(result.levels[0].steps).toHaveLength(1);
      // Second level: all children (parallelizable)
      expect(result.levels[1].steps).toHaveLength(3);
    });

    it('handles complex DAG with shared dependencies', () => {
      // Create DAG where same node is referenced multiple times
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a' },
        { call: 'GET /b', store_as: 'b', depends_on: ['a'] },
        { call: 'GET /c', store_as: 'c', depends_on: ['a'] },
        { call: 'GET /d', store_as: 'd', depends_on: ['b', 'a'] }, // 'a' is referenced twice
      ];

      const result = DAGExecutor.analyzeDAG(steps);

      expect(result.hasCycles).toBe(false);
      expect(result.levels).toHaveLength(3);
    });

    it('returns error for missing dependency without throwing', () => {
      const steps: CompositeStep[] = [
        { call: 'GET /a', store_as: 'a', depends_on: ['nonexistent'] },
      ];

      const result = DAGExecutor.analyzeDAG(steps);

      expect(result.hasCycles).toBe(true);
      expect(result.errorMessage).toContain("depends on 'nonexistent'");
      expect(result.levels).toHaveLength(0);
    });
  });
});


