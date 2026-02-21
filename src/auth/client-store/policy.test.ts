import { describe, expect, it } from 'vitest';
import { chooseEvictionDecision } from './policy.js';
import type { EvictionCandidateRecord } from './types.js';

const createCandidate = (overrides: Partial<EvictionCandidateRecord>): EvictionCandidateRecord => ({
  clientId: 'client',
  kind: 'dynamic',
  createdAt: 10,
  lastUsedAt: undefined,
  activeSessionCount: 0,
  pendingStateCount: 0,
  pendingAuthCodeCount: 0,
  isIdle: true,
  isNeverUsed: true,
  ageMs: 1000,
  ...overrides,
});

describe('chooseEvictionDecision', () => {
  it('prefers tier A dynamic idle never-used candidates', () => {
    const decision = chooseEvictionDecision([
      createCandidate({ clientId: 'dynamic-used', isNeverUsed: false, lastUsedAt: 500 }),
      createCandidate({ clientId: 'dynamic-never-older', createdAt: 100 }),
      createCandidate({ clientId: 'dynamic-never-oldest', createdAt: 10 }),
      createCandidate({ clientId: 'static-idle', kind: 'static', createdAt: 1 }),
    ], 0);

    expect(decision).toEqual({
      decision: 'evict',
      clientId: 'dynamic-never-oldest',
      tier: 'tier_a_dynamic_idle_never_used',
    });
  });

  it('uses tier B when no tier A candidate exists', () => {
    const decision = chooseEvictionDecision([
      createCandidate({ clientId: 'dynamic-used-old', isNeverUsed: false, lastUsedAt: 100 }),
      createCandidate({ clientId: 'dynamic-used-new', isNeverUsed: false, lastUsedAt: 1000 }),
      createCandidate({ clientId: 'static-idle', kind: 'static', createdAt: 1 }),
    ], 0);

    expect(decision).toEqual({
      decision: 'evict',
      clientId: 'dynamic-used-old',
      tier: 'tier_b_dynamic_idle',
    });
  });

  it('falls back to tier C for static idle clients', () => {
    const decision = chooseEvictionDecision([
      createCandidate({
        clientId: 'dynamic-active',
        isIdle: false,
        isNeverUsed: false,
        activeSessionCount: 1,
      }),
      createCandidate({ clientId: 'static-idle', kind: 'static', createdAt: 100 }),
    ], 0);

    expect(decision).toEqual({
      decision: 'evict',
      clientId: 'static-idle',
      tier: 'tier_c_any_idle',
    });
  });

  it('returns no-candidate when all clients are active or pending', () => {
    const decision = chooseEvictionDecision([
      createCandidate({
        clientId: 'dynamic-active',
        isIdle: false,
        isNeverUsed: false,
        activeSessionCount: 1,
      }),
      createCandidate({
        clientId: 'dynamic-pending-state',
        isIdle: false,
        isNeverUsed: false,
        pendingStateCount: 1,
      }),
      createCandidate({
        clientId: 'static-pending-code',
        kind: 'static',
        isIdle: false,
        isNeverUsed: false,
        pendingAuthCodeCount: 1,
      }),
    ], 0);

    expect(decision).toEqual({
      decision: 'no_candidate',
      reason: 'no_idle_candidates',
    });
  });

  it('respects idle grace period', () => {
    const decision = chooseEvictionDecision([
      createCandidate({ clientId: 'dynamic-fresh', ageMs: 50 }),
      createCandidate({ clientId: 'dynamic-old', ageMs: 1000 }),
    ], 100);

    expect(decision).toEqual({
      decision: 'evict',
      clientId: 'dynamic-old',
      tier: 'tier_a_dynamic_idle_never_used',
    });
  });
});
