/**
 * Tool name shortening strategies
 *
 * Why: MCP tool names combined with server name must stay under limits.
 * Different strategies offer trade-offs between readability and compactness.
 */

export enum NamingStrategy {
  None = 'none',
  Balanced = 'balanced',
  Iterative = 'iterative',
  Hash = 'hash',
  Auto = 'auto',
}

export interface OperationForNaming {
  operationId: string;
  method: string;
  path: string;
  tags?: string[];
}

export interface ShortenResult {
  name: string;
  truncated: boolean;
  strategy: NamingStrategy;
  originalLength: number;
  partsUsed?: number;
}

export interface SimilarPair {
  opA: OperationForNaming;
  opB: OperationForNaming;
  similarity: number;
}

export interface ShorteningOptions {
  maxLength: number;
  minParts?: number;           // Min parts to include (for balanced)
  minLength?: number;          // Min length in chars (for balanced)
  allOperations?: OperationForNaming[]; // Needed for balanced/collision detection
}

/**
 * Shorten tool name using specified strategy
 */
export function shortenToolName(
  op: OperationForNaming,
  strategy: NamingStrategy,
  maxLength: number,
  allOperations?: OperationForNaming[],
  options?: Partial<ShorteningOptions>
): ShortenResult {
  const originalLength = op.operationId.length;

  if (strategy === NamingStrategy.None) {
    return {
      name: op.operationId,
      truncated: false,
      strategy,
      originalLength,
    };
  }

  const opts: ShorteningOptions = {
    maxLength,
    minParts: options?.minParts ?? 3,
    minLength: options?.minLength ?? 20,
    allOperations: allOperations || [op],
  };

  let result: ShortenResult;

  switch (strategy) {
    case NamingStrategy.Balanced:
      result = shortenWithBalanced(op, opts);
      break;
    case NamingStrategy.Iterative:
      result = shortenWithIterative(op, opts);
      break;
    case NamingStrategy.Hash:
      result = shortenWithHash(op, opts);
      break;
    case NamingStrategy.Auto:
      // Try strategies in order: balanced → iterative → hash
      result = shortenWithBalanced(op, opts);
      if (result.name.length > maxLength) {
        result = shortenWithIterative(op, opts);
      }
      if (result.name.length > maxLength) {
        result = shortenWithHash(op, opts);
      }
      result.strategy = NamingStrategy.Auto;
      break;
    default:
      result = {
        name: op.operationId,
        truncated: false,
        strategy,
        originalLength,
      };
  }

  return result;
}

/**
 * Split camelCase/snake_case into parts
 */
function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[_\-\/]/)
    .filter(Boolean);
}

/**
 * Sanitize name to valid identifier
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Analyze part frequency across all operations
 */
function analyzeFrequency(operations: OperationForNaming[]): Map<string, number> {
  const partCounts = new Map<string, number>();
  
  operations.forEach(op => {
    const parts = splitCamelCase(op.operationId);
    const uniqueParts = new Set(parts.map(p => p.toLowerCase()));
    
    uniqueParts.forEach(part => {
      partCounts.set(part, (partCounts.get(part) || 0) + 1);
    });
  });
  
  return partCounts;
}

/**
 * Check if candidate is unique across all operations
 */
function isUniqueCandidate(
  candidate: Array<{ part: string; index: number }>,
  candidateName: string,
  op: OperationForNaming,
  allOps: OperationForNaming[]
): boolean {
  return !allOps.some(other => {
    if (other.operationId === op.operationId) return false;
    
    const otherParts = splitCamelCase(other.operationId);
    
    const otherCandidate = candidate
      .filter(c => c.index < otherParts.length)
      .map(c => otherParts[c.index])
      .filter(Boolean);
    
    const otherCandidateName = sanitizeName(otherCandidate.join('_'));
    
    return candidateName === otherCandidateName;
  });
}

/**
 * Extract path parameters from path
 */
function extractPathParams(path: string): string[] {
  return (path.match(/\{([^}]+)\}/g) || [])
    .map(p => p.slice(1, -1).replace(/[^a-z0-9]/gi, '').toLowerCase());
}

/**
 * Balanced strategy: Add parts by importance until unique, meaningful, and under limit
 */
function shortenWithBalanced(op: OperationForNaming, opts: ShorteningOptions): ShortenResult {
  const parts = splitCamelCase(op.operationId);
  const normalized = sanitizeName(parts.join('_'));
  
  // If already under limit, don't shorten
  if (normalized.length <= opts.maxLength) {
    return {
      name: normalized,
      truncated: false,
      strategy: NamingStrategy.Balanced,
      originalLength: op.operationId.length,
      partsUsed: parts.length,
    };
  }
  
  const allOps = opts.allOperations || [op];
  const total = allOps.length;
  const partCounts = analyzeFrequency(allOps);
  
  const verb = parts[0]?.toLowerCase();
  const knownVerbs = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];
  const hasVerb = knownVerbs.includes(verb);
  
  // Score each part by informativeness
  const partScores = parts.map((part, index) => {
    const lower = part.toLowerCase();
    const count = partCounts.get(lower) || 0;
    const frequency = count / total;
    
    const rarityScore = 1 - frequency;
    const verbBonus = (index === 0 && hasVerb) ? 2.0 : 0;
    const commonPenalty = frequency > 0.5 ? -0.5 : 0;
    
    return {
      part,
      index,
      frequency,
      score: rarityScore + verbBonus + commonPenalty,
    };
  });
  
  const sortedParts = [...partScores].sort((a, b) => b.score - a.score);
  
  let candidate: Array<{ part: string; index: number; score: number }> = [];
  let candidateName = '';
  let bestValidCandidate: { name: string; parts: number } | null = null;
  
  // Add parts iteratively
  for (const scored of sortedParts) {
    candidate.push(scored);
    candidate.sort((a, b) => a.index - b.index);
    candidateName = sanitizeName(candidate.map(c => c.part).join('_'));
    
    const isUnique = isUniqueCandidate(candidate, candidateName, op, allOps);
    const underLimit = candidateName.length <= opts.maxLength;
    const hasMinParts = candidate.length >= (opts.minParts || 3);
    const hasMinLength = candidateName.length >= (opts.minLength || 20);
    
    // Check if we've reached optimal
    if (isUnique && underLimit && hasMinParts && hasMinLength) {
      return {
        name: candidateName,
        truncated: true,
        strategy: NamingStrategy.Balanced,
        originalLength: op.operationId.length,
        partsUsed: candidate.length,
      };
    }
    
    // Track best valid (unique + under limit)
    if (isUnique && underLimit) {
      bestValidCandidate = {
        name: candidateName,
        parts: candidate.length,
      };
    }
    
    // Stop if over limit or too many parts
    if (candidateName.length > opts.maxLength || candidate.length >= Math.min(8, parts.length * 0.7)) {
      break;
    }
  }
  
  // Use best valid candidate if found
  if (bestValidCandidate) {
    return {
      name: bestValidCandidate.name,
      truncated: true,
      strategy: NamingStrategy.Balanced,
      originalLength: op.operationId.length,
      partsUsed: bestValidCandidate.parts,
    };
  }
  
  // Fallback: remove very common parts (≥95%)
  const veryCommon = new Set<string>();
  partCounts.forEach((count, part) => {
    if ((count / total) >= 0.95) veryCommon.add(part);
  });
  
  const filtered = parts.filter((p, i) => {
    if (i === 0 && hasVerb) return true;
    return !veryCommon.has(p.toLowerCase());
  });
  
  candidateName = sanitizeName(filtered.join('_'));
  
  if (candidateName.length > opts.maxLength) {
    candidateName = candidateName.substring(0, opts.maxLength);
  }
  
  return {
    name: candidateName,
    truncated: true,
    strategy: NamingStrategy.Balanced,
    originalLength: op.operationId.length,
    partsUsed: filtered.length,
  };
}

/**
 * Iterative strategy: Remove parts progressively until under limit
 */
function shortenWithIterative(op: OperationForNaming, opts: ShorteningOptions): ShortenResult {
  const originalParts = splitCamelCase(op.operationId);
  let parts = [...originalParts];
  const normalized = sanitizeName(parts.join('_'));
  
  // If already under limit, don't shorten
  if (normalized.length <= opts.maxLength) {
    return {
      name: normalized,
      truncated: false,
      strategy: NamingStrategy.Iterative,
      originalLength: op.operationId.length,
      partsUsed: parts.length,
    };
  }
  
  const allOps = opts.allOperations || [op];
  const total = allOps.length;
  const partCounts = analyzeFrequency(allOps);
  
  const verb = parts[0]?.toLowerCase();
  const knownVerbs = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];
  const hasVerb = knownVerbs.includes(verb);
  
  const pathParams = extractPathParams(op.path);
  
  const currentLength = () => sanitizeName(parts.join('_')).length;
  
  // Step 1: Remove very common noise (≥95%)
  if (currentLength() > opts.maxLength) {
    const veryCommon = new Set<string>();
    partCounts.forEach((count, part) => {
      if ((count / total) >= 0.95) veryCommon.add(part);
    });
    
    if (veryCommon.size > 0) {
      parts = parts.filter((p, i) => {
        if (i === 0 && hasVerb) return true;
        return !veryCommon.has(p.toLowerCase());
      });
    }
  }
  
  // Step 2: Remove common noise (≥80%)
  if (currentLength() > opts.maxLength) {
    const common = new Set<string>();
    partCounts.forEach((count, part) => {
      if ((count / total) >= 0.80 && (count / total) < 0.95) {
        common.add(part);
      }
    });
    
    if (common.size > 0) {
      parts = parts.filter((p, i) => {
        if (i === 0 && hasVerb) return true;
        return !common.has(p.toLowerCase());
      });
    }
  }
  
  // Step 3: Remove path parameter suffixes
  if (currentLength() > opts.maxLength) {
    const paramSuffixes = ['id', 'iid'];
    parts = parts.filter((p, i) => {
      if (i === 0 && hasVerb) return true;
      
      const lower = p.toLowerCase();
      if (paramSuffixes.includes(lower)) return false;
      
      const normalized = lower.replace(/id$|iid$/i, '');
      if (pathParams.includes(normalized) || pathParams.includes(lower)) {
        return false;
      }
      
      return true;
    });
  }
  
  // Step 4: Remove duplicates
  if (currentLength() > opts.maxLength) {
    const seen = new Set<string>();
    parts = parts.filter((p, i) => {
      if (i === 0 && hasVerb) return true;
      const lower = p.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
  }
  
  // Step 5: Remove moderately common (≥50%)
  if (currentLength() > opts.maxLength) {
    const moderate = new Set<string>();
    partCounts.forEach((count, part) => {
      if ((count / total) >= 0.50 && (count / total) < 0.80) {
        moderate.add(part);
      }
    });
    
    if (moderate.size > 0) {
      parts = parts.filter((p, i) => {
        if (i === 0 && hasVerb) return true;
        return !moderate.has(p.toLowerCase());
      });
    }
  }
  
  // Step 6: Keep only verb + last 2 parts
  if (currentLength() > opts.maxLength) {
    const keepCount = Math.min(3, parts.length);
    if (parts.length > keepCount) {
      const kept = hasVerb 
        ? [parts[0], ...parts.slice(-2)]
        : parts.slice(-keepCount);
      parts = kept;
    }
  }
  
  let result = sanitizeName(parts.join('_'));
  
  // Last resort: truncate
  if (result.length > opts.maxLength) {
    result = result.substring(0, opts.maxLength);
  }
  
  return {
    name: result,
    truncated: true,
    strategy: NamingStrategy.Iterative,
    originalLength: op.operationId.length,
    partsUsed: parts.length,
  };
}

/**
 * Hash strategy: <verb>_<resource>_<hash4>
 */
function shortenWithHash(op: OperationForNaming, opts: ShorteningOptions): ShortenResult {
  const verb = op.method.toLowerCase();
  const resource = extractResourceFromPath(op.path);
  const hash = stableHash(op.operationId, 4);
  
  let result = `${verb}_${resource}_${hash}`;
  
  // Ensure under limit
  if (result.length > opts.maxLength) {
    // Try shortening resource
    const shortResource = resource.substring(0, Math.max(3, opts.maxLength - verb.length - hash.length - 2));
    result = `${verb}_${shortResource}_${hash}`;
    
    // Last resort: truncate
    if (result.length > opts.maxLength) {
      result = result.substring(0, opts.maxLength);
    }
  }
  
  return {
    name: sanitizeName(result),
    truncated: true,
    strategy: NamingStrategy.Hash,
    originalLength: op.operationId.length,
  };
}

/**
 * Extract main resource from path
 */
function extractResourceFromPath(path: string): string {
  const segments = path.split('/').filter(s => s && !s.startsWith('{'));
  
  // Find last non-action meaningful segment
  const actionWords = ['protect', 'unprotect', 'merge', 'approve', 'cancel', 'authorize'];
  
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i].toLowerCase();
    if (!['api', 'v1', 'v2', 'v3', 'v4', 'repository'].includes(segment) && 
        !actionWords.includes(segment)) {
      return sanitizeName(segments[i]);
    }
  }
  
  return sanitizeName(segments[segments.length - 1] || 'resource');
}

/**
 * Generate stable short hash from string
 */
export function stableHash(str: string, length: number = 4): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  // Convert to base36 and take first N characters
  return Math.abs(hash).toString(36).substring(0, length).padEnd(length, '0');
}

/**
 * Calculate Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = Array(b.length + 1)
    .fill(null)
    .map(() => Array(a.length + 1).fill(null));

  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Normalize operation name for similarity comparison
 */
function normalizeForSimilarity(op: OperationForNaming): string {
  return op.operationId
    .toLowerCase()
    .replace(/^(get|post|put|delete|patch)/, '')
    .replace(/^apiv[0-9]/, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Pick most similar pairs of operations
 */
export function pickMostSimilarPairs(
  operations: OperationForNaming[],
  topN: number,
  threshold: number = 0.75
): SimilarPair[] {
  if (operations.length < 2) {
    return [];
  }

  const pairs: SimilarPair[] = [];
  const normalized = operations.map(op => normalizeForSimilarity(op));

  // Calculate similarity for all pairs
  for (let i = 0; i < operations.length; i++) {
    for (let j = i + 1; j < operations.length; j++) {
      const distance = levenshteinDistance(normalized[i], normalized[j]);
      const maxLen = Math.max(normalized[i].length, normalized[j].length);
      // Similarity: 1.0 (100%) = identical, 0.0 (0%) = completely different
      const similarity = 1 - (distance / maxLen);

      // Keep pairs with similarity >= threshold (high similarity)
      if (similarity >= threshold) {
        pairs.push({
          opA: operations[i],
          opB: operations[j],
          similarity,
        });
      }
    }
  }

  // Sort by similarity (highest = most similar)
  pairs.sort((a, b) => b.similarity - a.similarity);

  // Pick top N pairs, trying to avoid duplicate operations
  const selected: SimilarPair[] = [];
  const usedOps = new Set<string>();

  for (const pair of pairs) {
    if (selected.length >= topN) break;

    const aId = pair.opA.operationId;
    const bId = pair.opB.operationId;

    const isNew = !usedOps.has(aId) && !usedOps.has(bId);
    
    if (isNew || selected.length < topN) {
      selected.push(pair);
      usedOps.add(aId);
      usedOps.add(bId);
    }
  }

  // If we don't have enough, add pairs even with reused ops
  if (selected.length < topN) {
    for (const pair of pairs) {
      if (selected.length >= topN) break;
      if (!selected.includes(pair)) {
        selected.push(pair);
      }
    }
  }

  return selected.slice(0, topN);
}

/**
 * Detect potential collisions when shortening multiple operations
 */
export function detectCollisions(
  operations: OperationForNaming[],
  strategy: NamingStrategy,
  maxLength: number,
  options?: Partial<ShorteningOptions>
): Map<string, OperationForNaming[]> {
  const nameMap = new Map<string, OperationForNaming[]>();

  for (const op of operations) {
    const result = shortenToolName(op, strategy, maxLength, operations, options);
    const existing = nameMap.get(result.name) || [];
    existing.push(op);
    nameMap.set(result.name, existing);
  }

  // Filter to only collisions
  const collisions = new Map<string, OperationForNaming[]>();
  for (const [name, ops] of nameMap.entries()) {
    if (ops.length > 1) {
      collisions.set(name, ops);
    }
  }

  return collisions;
}
