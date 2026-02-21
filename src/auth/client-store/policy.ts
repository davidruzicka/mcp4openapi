import type { EvictionCandidateRecord, EvictionDecision, EvictionTierId } from './types.js';

interface EvictionTierRule {
  id: EvictionTierId;
  predicate: (candidate: EvictionCandidateRecord, idleGraceMs: number) => boolean;
}

const EVICTION_TIERS: readonly EvictionTierRule[] = [
  {
    id: 'tier_a_dynamic_idle_never_used',
    predicate: (candidate, idleGraceMs) =>
      candidate.kind === 'dynamic'
      && candidate.isIdle
      && candidate.isNeverUsed
      && candidate.ageMs >= idleGraceMs,
  },
  {
    id: 'tier_b_dynamic_idle',
    predicate: (candidate, idleGraceMs) =>
      candidate.kind === 'dynamic'
      && candidate.isIdle
      && candidate.ageMs >= idleGraceMs,
  },
  {
    id: 'tier_c_any_idle',
    predicate: (candidate, idleGraceMs) =>
      candidate.isIdle
      && candidate.ageMs >= idleGraceMs,
  },
];

const compareCandidates = (left: EvictionCandidateRecord, right: EvictionCandidateRecord): number => {
  const leftLast = left.lastUsedAt ?? left.createdAt;
  const rightLast = right.lastUsedAt ?? right.createdAt;
  if (leftLast !== rightLast) {
    return leftLast - rightLast;
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }

  return left.clientId.localeCompare(right.clientId);
};

export function chooseEvictionDecision(
  candidates: EvictionCandidateRecord[],
  idleGraceMs: number,
): EvictionDecision {
  for (const tier of EVICTION_TIERS) {
    const tierCandidates = candidates
      .filter((candidate) => tier.predicate(candidate, idleGraceMs))
      .sort(compareCandidates);

    if (tierCandidates.length > 0) {
      return {
        decision: 'evict',
        clientId: tierCandidates[0].clientId,
        tier: tier.id,
      };
    }
  }

  return {
    decision: 'no_candidate',
    reason: 'no_idle_candidates',
  };
}
