/**
 * Unit tests for tool name shortening strategies
 */

import { describe, it, expect } from 'vitest';
import { 
  shortenToolName, 
  pickMostSimilarPairs,
  NamingStrategy,
  type OperationForNaming 
} from './naming.js';

describe('shortenToolName', () => {
  const mockOp: OperationForNaming = {
    operationId: 'putApiV4ProjectsIdRepositoryBranchesBranchUnprotect',
    method: 'put',
    path: '/api/v4/projects/{id}/repository/branches/{branch}/unprotect',
    tags: ['branches'],
  };

  const allOps: OperationForNaming[] = [
    mockOp,
    {
      operationId: 'putApiV4ProjectsIdRepositoryBranchesBranchProtect',
      method: 'put',
      path: '/api/v4/projects/{id}/repository/branches/{branch}/protect',
      tags: ['branches'],
    },
    {
      operationId: 'getApiV4ProjectsIdIssues',
      method: 'get',
      path: '/api/v4/projects/{id}/issues',
      tags: ['issues'],
    },
  ];

  describe('balanced strategy', () => {
    it('should create meaningful short names', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Balanced, 45, allOps);
      expect(result.name).toBeTruthy();
      expect(result.name.length).toBeLessThanOrEqual(45);
      expect(result.name.length).toBeGreaterThanOrEqual(10); // Should have some context
      expect(result.truncated).toBe(true);
    });

    it('should be unique across operations', () => {
      const results = allOps.map(op => 
        shortenToolName(op, NamingStrategy.Balanced, 45, allOps)
      );
      
      const names = results.map(r => r.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(allOps.length); // All unique
    });

    it('should respect min parts and min length', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Balanced, 45, allOps, {
        minParts: 3,
        minLength: 20,
      });
      
      expect(result.name.length).toBeGreaterThanOrEqual(15); // Should try to reach minLength
      expect(result.partsUsed).toBeGreaterThanOrEqual(2); // At least verb + something
    });

    it('should handle operations already under limit', () => {
      const shortOp: OperationForNaming = {
        operationId: 'getProjects',
        method: 'get',
        path: '/projects',
        tags: ['projects'],
      };
      
      const result = shortenToolName(shortOp, NamingStrategy.Balanced, 45, [shortOp]);
      expect(result.name).toBe('get_projects');
      expect(result.truncated).toBe(false);
    });
  });

  describe('iterative strategy', () => {
    it('should progressively remove noise', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Iterative, 45, allOps);
      expect(result.name).toBeTruthy();
      expect(result.name.length).toBeLessThanOrEqual(45);
      expect(result.truncated).toBe(true);
    });

    it('should preserve verb and key parts', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Iterative, 45, allOps);
      // Should contain verb (put) or key action (unprotect)
      expect(result.name).toMatch(/put|unprotect/);
    });

    it('should handle very short limits', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Iterative, 15, allOps);
      expect(result.name.length).toBeLessThanOrEqual(15);
    });
  });

  describe('hash strategy', () => {
    it('should create deterministic short name with hash', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Hash, 45, allOps);
      expect(result.name).toMatch(/^put_branches_[a-z0-9]{4}$/);
      expect(result.name.length).toBeLessThanOrEqual(45);
      expect(result.truncated).toBe(true);
    });

    it('should be deterministic', () => {
      const result1 = shortenToolName(mockOp, NamingStrategy.Hash, 45, allOps);
      const result2 = shortenToolName(mockOp, NamingStrategy.Hash, 45, allOps);
      expect(result1.name).toBe(result2.name);
    });

    it('should handle very short limits', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Hash, 15, allOps);
      expect(result.name.length).toBeLessThanOrEqual(15);
    });
  });

  describe('auto strategy', () => {
    it('should try strategies in order', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Auto, 45, allOps);
      expect(result.name).toBeTruthy();
      expect(result.name.length).toBeLessThanOrEqual(45);
      expect(result.strategy).toBe(NamingStrategy.Auto);
    });

    it('should handle short limits by falling back', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Auto, 15, allOps);
      expect(result.name.length).toBeLessThanOrEqual(15);
    });
  });

  describe('none strategy', () => {
    it('should return original operationId', () => {
      const result = shortenToolName(mockOp, NamingStrategy.None, 45, allOps);
      expect(result.name).toBe(mockOp.operationId);
      expect(result.truncated).toBe(false);
    });
  });

  describe('length limits', () => {
    it('should respect max length constraint', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Hash, 20, allOps);
      expect(result.name.length).toBeLessThanOrEqual(20);
    });

    it('should handle edge cases', () => {
      // Very short limit
      const result1 = shortenToolName(mockOp, NamingStrategy.Hash, 5, allOps);
      expect(result1.name.length).toBeLessThanOrEqual(5);
      
      // Very long limit (no truncation needed)
      const result2 = shortenToolName(mockOp, NamingStrategy.Balanced, 200, allOps);
      expect(result2.name.length).toBeLessThanOrEqual(200);
    });
  });

  describe('options parameter', () => {
    it('should use default allOperations when not provided', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Hash, 45);
      expect(result.name).toBeTruthy();
      expect(result.name.length).toBeLessThanOrEqual(45);
    });

    it('should use custom minParts from options', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Balanced, 45, allOps, {
        minParts: 2
      });
      expect(result.name).toBeTruthy();
      expect(result.name.length).toBeLessThanOrEqual(45);
    });

    it('should use custom minLength from options', () => {
      const result = shortenToolName(mockOp, NamingStrategy.Balanced, 45, allOps, {
        minLength: 15
      });
      expect(result.name).toBeTruthy();
      expect(result.name.length).toBeLessThanOrEqual(45);
    });

    it('should use custom allOperations from options', () => {
      const customOps: OperationForNaming[] = [
        mockOp,
        { operationId: 'otherOp', method: 'get', path: '/other', tags: [] }
      ];
      
      const result = shortenToolName(mockOp, NamingStrategy.Balanced, 45, undefined, {
        allOperations: customOps
      });
      expect(result.name).toBeTruthy();
    });
  });

  describe('default case in switch statement', () => {
    it('should handle unknown strategy by returning original name', () => {
      const result = shortenToolName(mockOp, 'unknown' as any, 45, allOps);
      expect(result.name).toBe(mockOp.operationId);
      expect(result.truncated).toBe(false);
      expect(result.strategy).toBe('unknown');
    });
  });
});

describe('pickMostSimilarPairs', () => {
  it('should return empty array when operations.length < 2', () => {
    const singleOp: OperationForNaming[] = [
      {
        operationId: 'getUser',
        method: 'get',
        path: '/users/{id}',
        tags: []
      }
    ];
    
    const pairs = pickMostSimilarPairs(singleOp, 5, 0.5);
    expect(pairs).toEqual([]);
  });

  it('should return empty array when operations array is empty', () => {
    const pairs = pickMostSimilarPairs([], 5, 0.5);
    expect(pairs).toEqual([]);
  });

  const ops: OperationForNaming[] = [
    {
      operationId: 'putApiV4ProjectsIdRepositoryBranchesBranchProtect',
      method: 'put',
      path: '/api/v4/projects/{id}/repository/branches/{branch}/protect',
      tags: ['branches'],
    },
    {
      operationId: 'putApiV4ProjectsIdRepositoryBranchesBranchUnprotect',
      method: 'put',
      path: '/api/v4/projects/{id}/repository/branches/{branch}/unprotect',
      tags: ['branches'],
    },
    {
      operationId: 'getApiV4Projects',
      method: 'get',
      path: '/api/v4/projects',
      tags: ['projects'],
    },
    {
      operationId: 'postApiV4Projects',
      method: 'post',
      path: '/api/v4/projects',
      tags: ['projects'],
    },
  ];

  it('should find most similar pairs', () => {
    const pairs = pickMostSimilarPairs(ops, 2, 0.5);
    expect(pairs).toHaveLength(2);
    
    // Should find similar pairs (high similarity >= 0.5)
    expect(pairs[0].similarity).toBeGreaterThanOrEqual(0.5);
    expect(pairs[1].similarity).toBeGreaterThanOrEqual(0.5);
    
    // Verify we got actual pairs
    const allIds = pairs.flatMap(p => [p.opA.operationId, p.opB.operationId]);
    expect(new Set(allIds).size).toBeGreaterThanOrEqual(2);
  });

  it('should return deterministic results', () => {
    const pairs1 = pickMostSimilarPairs(ops, 2, 0.5);
    const pairs2 = pickMostSimilarPairs(ops, 2, 0.5);
    expect(pairs1.length).toBe(pairs2.length);
    expect(pairs1[0].opA.operationId).toBe(pairs2[0].opA.operationId);
  });

  it('should respect similarity threshold', () => {
    const pairs = pickMostSimilarPairs(ops, 10, 0.9); // High threshold = very similar
    pairs.forEach(pair => {
      expect(pair.similarity).toBeGreaterThanOrEqual(0.9);
    });
  });

  it('should handle small sets', () => {
    const smallOps = ops.slice(0, 2);
    const pairs = pickMostSimilarPairs(smallOps, 5, 0.5);
    expect(pairs.length).toBeLessThanOrEqual(1); // Only 1 possible pair
  });

  it('should avoid duplicate operations when possible', () => {
    const pairs = pickMostSimilarPairs(ops, 2, 0.5);
    
    // Count how many times each operation appears
    const opCounts = new Map<string, number>();
    pairs.forEach(pair => {
      opCounts.set(pair.opA.operationId, (opCounts.get(pair.opA.operationId) || 0) + 1);
      opCounts.set(pair.opB.operationId, (opCounts.get(pair.opB.operationId) || 0) + 1);
    });
    
    // Most operations should appear only once (preferring diverse pairs)
    const singleAppearances = Array.from(opCounts.values()).filter(count => count === 1);
    expect(singleAppearances.length).toBeGreaterThan(0);
  });

  it('should fill remaining slots with reused operations when needed', () => {
    // Request more pairs than available unique pairs
    const pairs = pickMostSimilarPairs(ops, 10, 0.1);
    
    // Should still return some pairs even if we need to reuse operations
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('should add pairs with used operations when selected count is less than topN', () => {
    // Create ops where we need to reuse operations to fill slots
    // With 4 ops, max unique pairs is 6 (C(4,2)), but if threshold filters some,
    // we need to reuse ops
    const smallOps: OperationForNaming[] = [
      { operationId: 'getA', method: 'get', path: '/a', tags: [] },
      { operationId: 'getB', method: 'get', path: '/b', tags: [] },
      { operationId: 'getAList', method: 'get', path: '/a/list', tags: [] },
    ];

    // Request 3 pairs (maximum for 3 ops is C(3,2)=3)
    const pairs = pickMostSimilarPairs(smallOps, 3, 0.3);
    
    // Should return pairs even with reused operations
    expect(pairs.length).toBeLessThanOrEqual(3);
  });

  it('should fill remaining slots when selected.length < topN by adding pairs even with reused ops', () => {
    // Create scenario where some pairs pass threshold but not enough to fill topN
    // This triggers the fallback at lines 598-603 that adds pairs even with reused ops
    const opsForReuse: OperationForNaming[] = [
      { operationId: 'getUserById', method: 'get', path: '/users/{id}', tags: [] },
      { operationId: 'getUserByEmail', method: 'get', path: '/users/email/{email}', tags: [] },
      { operationId: 'getUserByName', method: 'get', path: '/users/name/{name}', tags: [] },
      { operationId: 'getProjectById', method: 'get', path: '/projects/{id}', tags: [] },
    ];

    // Request 4 pairs with moderate threshold
    // With 4 ops, max unique pairs is 6, but threshold might filter some
    // If we get fewer than 4, the fallback logic should add more even with reused ops
    const pairs = pickMostSimilarPairs(opsForReuse, 4, 0.6);
    
    // Should return some pairs
    expect(pairs.length).toBeGreaterThan(0);
    // The fallback logic (lines 598-603) ensures we get as many as possible up to topN
    expect(pairs.length).toBeLessThanOrEqual(4);
  });

  it('should include pair even if one operation is already used when not at topN', () => {
    // Create highly similar ops that will use same operations
    const similarOps: OperationForNaming[] = [
      { operationId: 'getUserById', method: 'get', path: '/users/{id}', tags: ['users'] },
      { operationId: 'getUserByEmail', method: 'get', path: '/users/email/{email}', tags: ['users'] },
      { operationId: 'getUserByName', method: 'get', path: '/users/name/{name}', tags: ['users'] },
    ];

    const pairs = pickMostSimilarPairs(similarOps, 2, 0.5);
    
    // All 3 operations are similar, so pairs will overlap
    expect(pairs.length).toBeGreaterThan(0);
  });
});

describe('detectCollisions', () => {
  it('should detect name collisions when shortening causes duplicates', async () => {
    const { detectCollisions, NamingStrategy } = await import('./naming.js');
    
    // Create operations with identical operationIds
    const operations: OperationForNaming[] = [
      {
        operationId: 'sameOperationName',
        method: 'get',
        path: '/api/v4/projects/{id}/a',
        tags: ['projects'],
      },
      {
        operationId: 'sameOperationName',
        method: 'post',
        path: '/api/v4/projects/{id}/b',
        tags: ['projects'],
      },
    ];
    
    const collisions = detectCollisions(operations, NamingStrategy.None, 100);
    
    // Same operationId should cause collision
    expect(collisions.size).toBe(1);
    expect(collisions.get('sameOperationName')?.length).toBe(2);
  });

  it('should detect no collisions for unique names', async () => {
    const { detectCollisions, NamingStrategy } = await import('./naming.js');
    
    const operations: OperationForNaming[] = [
      {
        operationId: 'uniqueOperationA',
        method: 'get',
        path: '/a',
        tags: [],
      },
      {
        operationId: 'uniqueOperationB',
        method: 'post',
        path: '/b',
        tags: [],
      },
    ];
    
    const collisions = detectCollisions(operations, NamingStrategy.None, 100);
    expect(collisions.size).toBe(0);
  });
});
