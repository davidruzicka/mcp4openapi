import { describe, expect, it } from 'vitest';
import {
  buildProposalKey,
  classifyProposalMatchRelation,
  planProposalResolution,
  rankProposalCandidateMatches,
  type ProposalCandidateArtifact,
  type ProposalCandidateMatch,
} from './proposal-intake.js';

function buildMatch(overrides: Partial<ProposalCandidateMatch> = {}): ProposalCandidateMatch {
  return {
    number: 155,
    kind: 'issue',
    state: 'open',
    workflowState: 'candidate',
    relation: 'exact-duplicate',
    title: 'Add bounded cache invalidation metrics for response cache',
    url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
    ...overrides,
  };
}

function buildArtifact(overrides: Partial<ProposalCandidateArtifact> = {}): ProposalCandidateArtifact {
  return {
    number: 154,
    kind: 'issue',
    state: 'open',
    workflowState: 'candidate',
    title: 'Add bounded cache invalidation metrics for response cache',
    body: 'Add narrow metrics and targeted tests for cache invalidation counts.',
    url: 'https://github.com/davidruzicka/mcp4openapi/issues/154',
    ...overrides,
  };
}

describe('proposal-intake', () => {
  describe('buildProposalKey', () => {
    it('normalizes punctuation, casing, and whitespace into a stable proposal key', () => {
      expect(buildProposalKey(' Add bounded-cache invalidation metrics!!! ')).toBe('add-bounded-cache-invalidation-metrics');
    });
  });

  describe('planProposalResolution', () => {
    it('comments on an existing open pre-implementation issue for duplicate proposals', () => {
      const resolution = planProposalResolution({
        proposalTitle: 'Add bounded cache invalidation metrics for response cache',
        matches: [buildMatch()],
      });

      expect(resolution).toEqual({
        action: 'comment-existing',
        proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
        reason: 'open pre-implementation issue already tracks the same work',
        targetIssueNumber: 155,
      });
    });

    it('creates and links a fresh issue when the best open match is already actively planned', () => {
      const resolution = planProposalResolution({
        proposalTitle: 'Add bounded cache invalidation metrics for response cache',
        matches: [buildMatch({ workflowState: 'planned', relation: 'near-duplicate' })],
      });

      expect(resolution).toEqual({
        action: 'create-and-link',
        proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
        reason: 'existing open work is already active, so a fresh linked follow-up is safer',
        targetIssueNumber: 155,
      });
    });

    it('creates and links a fresh issue for closed regressions or follow-ups', () => {
      const resolution = planProposalResolution({
        proposalTitle: 'Regression: cache invalidation metrics stopped emitting after refactor',
        matches: [buildMatch({ state: 'closed', relation: 'regression' })],
      });

      expect(resolution).toEqual({
        action: 'create-and-link',
        proposalKey: 'regression-cache-invalidation-metrics-stopped-emitting-after-refactor',
        reason: 'closed work only supports a linked regression or follow-up issue',
        targetIssueNumber: 155,
      });
    });

    it('rejects exact duplicates of already closed work instead of reopening the same thread', () => {
      const resolution = planProposalResolution({
        proposalTitle: 'Add bounded cache invalidation metrics for response cache',
        matches: [buildMatch({ state: 'closed' })],
      });

      expect(resolution).toEqual({
        action: 'reject-as-duplicate',
        proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
        reason: 'closed exact duplicate does not justify a fresh issue',
        targetIssueNumber: 155,
      });
    });

    it('creates a fresh issue when no relevant match exists', () => {
      const resolution = planProposalResolution({
        proposalTitle: 'Add profile routing observability budget warnings',
        matches: [],
      });

      expect(resolution).toEqual({
        action: 'create-fresh',
        proposalKey: 'add-profile-routing-observability-budget-warnings',
        reason: 'no relevant existing issue or pull request matches this proposal',
      });
    });

    it('returns no-action when multiple competing matches make the duplicate verdict ambiguous', () => {
      const resolution = planProposalResolution({
        proposalTitle: 'Add bounded cache invalidation metrics for response cache',
        matches: [
          buildMatch({ number: 155, relation: 'near-duplicate' }),
          buildMatch({ number: 166, relation: 'related-follow-up' }),
        ],
      });

      expect(resolution).toEqual({
        action: 'no-action',
        proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
        reason: 'multiple competing matches require human clarification before acting',
      });
    });

    it('falls back to a fresh issue when the only match is a related follow-up or an unsupported open state', () => {
      expect(planProposalResolution({
        proposalTitle: 'Add profile routing observability budget warnings',
        matches: [buildMatch({ relation: 'related-follow-up' })],
      })).toEqual({
        action: 'create-fresh',
        proposalKey: 'add-profile-routing-observability-budget-warnings',
        reason: 'no relevant existing issue or pull request matches this proposal',
      });

      expect(planProposalResolution({
        proposalTitle: 'Add bounded cache invalidation metrics for response cache',
        matches: [buildMatch({ workflowState: 'needs-plan', state: 'open', relation: 'regression' })],
      })).toEqual({
        action: 'create-fresh',
        proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
        reason: 'no relevant existing issue or pull request matches this proposal',
      });
    });
  });

  describe('classifyProposalMatchRelation', () => {
    it('detects exact duplicates from stable normalized titles', () => {
      expect(classifyProposalMatchRelation({
        proposalTitle: 'Add bounded cache invalidation metrics for response cache',
        proposalBody: 'Need narrow metrics and tests.',
        candidateTitle: ' Add bounded-cache invalidation metrics for response cache ',
        candidateBody: 'Same scope, same tests.',
        candidateState: 'open',
      })).toBe('exact-duplicate');
    });

    it('detects regressions and follow-ups before falling back to near-duplicate matching', () => {
      expect(classifyProposalMatchRelation({
        proposalTitle: 'Regression: cache invalidation metrics stopped emitting after refactor',
        proposalBody: 'A recent refactor broke the existing metric emission path.',
        candidateTitle: 'Add bounded cache invalidation metrics for response cache',
        candidateBody: 'Ship narrow metrics and tests for cache invalidation counts.',
        candidateState: 'closed',
      })).toBe('regression');

      expect(classifyProposalMatchRelation({
        proposalTitle: 'Follow-up: extend cache invalidation metrics with warning thresholds',
        proposalBody: 'Extend the existing work with budget warnings.',
        candidateTitle: 'Add bounded cache invalidation metrics for response cache',
        candidateBody: 'Ship narrow metrics and tests for cache invalidation counts.',
        candidateState: 'closed',
      })).toBe('related-follow-up');
    });

    it('returns near-duplicate only for sufficiently similar bounded scope', () => {
      expect(classifyProposalMatchRelation({
        proposalTitle: 'Add cache invalidation count metrics and tests',
        proposalBody: 'Track invalidation counters and add focused tests.',
        candidateTitle: 'Add bounded cache invalidation metrics for response cache',
        candidateBody: 'Add narrow metrics and targeted tests for cache invalidation counts.',
        candidateState: 'open',
      })).toBe('near-duplicate');

      expect(classifyProposalMatchRelation({
        proposalTitle: 'Document OAuth setup troubleshooting guide',
        proposalBody: 'Add setup docs only.',
        candidateTitle: 'Add bounded cache invalidation metrics for response cache',
        candidateBody: 'Add narrow metrics and targeted tests for cache invalidation counts.',
        candidateState: 'open',
      })).toBeNull();
    });
  });

  describe('rankProposalCandidateMatches', () => {
    it('returns bounded ranked matches and excludes the proposal issue itself', () => {
      const matches = rankProposalCandidateMatches({
        proposalNumber: 155,
        proposalTitle: 'Add cache invalidation count metrics and tests',
        proposalBody: 'Track invalidation counters and add focused tests.',
        candidates: [
          buildArtifact(),
          buildArtifact({ number: 156, title: 'Follow-up: cache invalidation metrics warning thresholds', state: 'closed', workflowState: 'merged' }),
          buildArtifact({ number: 155, title: 'Add cache invalidation count metrics and tests' }),
          buildArtifact({ number: 200, title: 'Document OAuth setup troubleshooting guide', body: 'Docs only.' }),
        ],
        maxMatches: 2,
      });

      expect(matches).toHaveLength(2);
      expect(matches.map((match) => match.number)).toEqual([156, 154]);
      expect(matches.map((match) => match.relation)).toEqual(['related-follow-up', 'near-duplicate']);
    });

    it('sorts same-relation matches by issue number and ignores empty-token candidates', () => {
      const matches = rankProposalCandidateMatches({
        proposalNumber: 999,
        proposalTitle: 'Add cache invalidation count metrics and tests',
        proposalBody: 'Track invalidation counters and add focused tests.',
        candidates: [
          buildArtifact({ number: 170, title: 'Add cache invalidation count metrics and tests' }),
          buildArtifact({ number: 169, title: 'Add cache invalidation count metrics and tests' }),
          buildArtifact({ number: 171, title: 'A an and the', body: 'To of in on' }),
        ],
        maxMatches: 5,
      });

      expect(matches.map((match) => match.number)).toEqual([169, 170]);
      expect(matches.every((match) => match.number !== 171)).toBe(true);
    });
  });
});
