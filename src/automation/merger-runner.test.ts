import { describe, expect, it } from 'vitest';
import {
  buildMergeGateEvaluationComment,
  evaluateMergeGate,
  type MergerCiCheck,
  type MergerPullRequest,
  type MergerReviewArtifact,
  type MergerReviewThread,
  type MergerThreadComment,
} from './merger-runner.js';

describe('merger-runner', () => {
  describe('evaluateMergeGate', () => {
    it('marks a PR ready to merge when current-head approval, resolved threads, and green CI all exist', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 160,
          headSha: 'abc123',
          labels: ['agent:created', 'agent:review:required', 'agent:review:done'],
        }),
        threadComments: [],
        reviews: [
          buildReview({
            id: 1,
            submittedAt: '2026-03-14T17:55:00Z',
            status: 'approved',
            headSha: 'abc123',
          }),
        ],
        reviewThreads: [
          buildReviewThread({ id: 'thread-1', isResolved: true }),
        ],
        ciChecks: [
          { name: 'test', status: 'completed', conclusion: 'success' },
          { name: 'lint', status: 'completed', conclusion: 'neutral' },
        ],
      });

      expect(evaluation.ready).toBe(true);
      expect(evaluation.reasons).toEqual([]);
      expect(evaluation.labelsToAdd).toContain('agent:ready-to-merge');
      expect(evaluation.labelsToRemove).not.toContain('agent:ready-to-merge');
      expect(evaluation.commentBody).toContain('status: ready-to-merge');
      expect(evaluation.commentBody).toContain('head-sha: abc123');
    });

    it('treats a legacy reviewed label as a migration-era review requirement signal', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 166,
          headSha: 'legacy-sha',
          labels: ['agent:created', 'agent:reviewed'],
        }),
        threadComments: [],
        reviews: [
          buildReview({
            id: 8,
            submittedAt: '2026-03-14T17:55:00Z',
            status: 'approved',
            headSha: 'legacy-sha',
          }),
        ],
        reviewThreads: [],
        ciChecks: [
          { name: 'test', status: 'completed', conclusion: 'success' },
        ],
      });

      expect(evaluation.ready).toBe(true);
      expect(evaluation.reasons).toEqual([]);
      expect(evaluation.labelsToAdd).toContain('agent:ready-to-merge');
    });

    it('blocks merge readiness when the only approval is stale for an older head sha', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 161,
          headSha: 'new-sha',
          labels: ['agent:review:required', 'agent:review:done', 'agent:ready-to-merge'],
        }),
        threadComments: [],
        reviews: [
          buildReview({
            id: 2,
            submittedAt: '2026-03-14T17:55:00Z',
            status: 'approved',
            headSha: 'old-sha',
          }),
        ],
        reviewThreads: [],
        ciChecks: [
          { name: 'test', status: 'completed', conclusion: 'success' },
        ],
      });

      expect(evaluation.ready).toBe(false);
      expect(evaluation.reasons).toContain('missing-current-approval');
      expect(evaluation.labelsToRemove).toContain('agent:ready-to-merge');
      expect(evaluation.commentBody).toContain('missing-current-approval');
    });

    it('treats a later current-head changes-requested review as superseding an earlier approval', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 162,
          headSha: 'abc123',
          labels: ['agent:review:required', 'agent:review:done'],
        }),
        threadComments: [],
        reviews: [
          buildReview({
            id: 3,
            submittedAt: '2026-03-14T17:40:00Z',
            status: 'approved',
            headSha: 'abc123',
          }),
          buildReview({
            id: 4,
            submittedAt: '2026-03-14T17:50:00Z',
            status: 'changes-requested',
            headSha: 'abc123',
          }),
        ],
        reviewThreads: [],
        ciChecks: [
          { name: 'test', status: 'completed', conclusion: 'success' },
        ],
      });

      expect(evaluation.ready).toBe(false);
      expect(evaluation.reasons).toContain('missing-current-approval');
      expect(evaluation.summary).toContain('changes-requested');
    });

    it('blocks merge readiness for active reviewer leases, unresolved threads, failed CI, or human hold labels', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 163,
          headSha: 'abc123',
          labels: ['agent:review:required', 'human:hold'],
        }),
        threadComments: [
          buildReviewingComment({ headSha: 'abc123', timestamp: '2026-03-14T17:50:00Z' }),
        ],
        reviews: [
          buildReview({
            id: 5,
            submittedAt: '2026-03-14T17:45:00Z',
            status: 'approved',
            headSha: 'abc123',
          }),
        ],
        reviewThreads: [
          buildReviewThread({ id: 'thread-1', isResolved: false }),
        ],
        ciChecks: [
          { name: 'test', status: 'completed', conclusion: 'failure' },
          { name: 'lint', status: 'in_progress', conclusion: null },
        ],
      });

      expect(evaluation.ready).toBe(false);
      expect(evaluation.reasons).toEqual(expect.arrayContaining([
        'human-hold',
        'review-in-progress',
        'unresolved-review-threads',
        'ci-not-green',
      ]));
    });

    it('blocks merge readiness when reviewer-owned threads receive newer human replies after approval', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 164,
          headSha: 'abc123',
          labels: ['agent:review:required', 'agent:review:done'],
        }),
        threadComments: [],
        reviews: [
          buildReview({
            id: 6,
            submittedAt: '2026-03-14T17:45:00Z',
            status: 'approved',
            headSha: 'abc123',
          }),
        ],
        reviewThreads: [
          buildReviewThread({
            id: 'thread-2',
            isResolved: true,
            comments: [
              buildReviewThreadComment({
                id: 'thread-comment-1',
                authorLogin: 'github-actions[bot]',
                updatedAt: '2026-03-14T17:40:00Z',
                body: buildReviewerThreadMetadataComment({
                  status: 'commented',
                  headSha: 'abc123',
                  timestamp: '2026-03-14T17:40:00Z',
                }),
              }),
              buildReviewThreadComment({
                id: 'thread-comment-2',
                authorLogin: 'human-reviewer',
                updatedAt: '2026-03-14T17:50:00Z',
                body: 'Please confirm the error path is covered.',
              }),
            ],
          }),
        ],
        ciChecks: [
          { name: 'test', status: 'completed', conclusion: 'success' },
        ],
      });

      expect(evaluation.ready).toBe(false);
      expect(evaluation.reasons).toContain('review-follow-up-pending');
    });

    it('blocks merge readiness when branch protection requires more than the bounded single-agent approval lane', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 165,
          headSha: 'abc123',
          labels: ['agent:review:required', 'agent:review:done'],
        }),
        threadComments: [],
        reviews: [
          buildReview({
            id: 7,
            submittedAt: '2026-03-14T17:55:00Z',
            status: 'approved',
            headSha: 'abc123',
          }),
        ],
        reviewThreads: [],
        ciChecks: [
          { name: 'test', status: 'completed', conclusion: 'success' },
        ],
        branchProtection: {
          requiredApprovingReviewCount: 2,
          requiresCodeOwnerReviews: false,
          allowedMergeMethods: ['squash'],
        },
      });

      expect(evaluation.ready).toBe(false);
      expect(evaluation.reasons).toContain('branch-protection-review-policy');
    });
  });

  describe('buildMergeGateEvaluationComment', () => {
    it('includes visible agent disclosure plus machine-readable merger metadata', () => {
      const comment = buildMergeGateEvaluationComment({
        repository: 'davidruzicka/mcp4openapi',
        pullRequestNumber: 164,
        headSha: 'merge123',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        ready: false,
        summary: 'Merge gates are not yet satisfied.',
        reasons: ['ci-not-green', 'unresolved-review-threads'],
      });

      expect(comment).toContain('🤖 Agent note (merger)');
      expect(comment).toContain('status: blocked');
      expect(comment).toContain('pr-number: 164');
      expect(comment).toContain('head-sha: merge123');
      expect(comment).toContain('Reasons: ci-not-green, unresolved-review-threads');
    });
  });
});

function buildPullRequest(input: {
  number: number;
  headSha: string;
  labels: readonly string[];
  draft?: boolean;
}): MergerPullRequest {
  return {
    number: input.number,
    title: `PR ${input.number}`,
    url: `https://github.com/davidruzicka/mcp4openapi/pull/${input.number}`,
    draft: input.draft ?? false,
    headSha: input.headSha,
    updatedAt: '2026-03-14T17:55:00Z',
    labels: input.labels,
  };
}

function buildReview(input: {
  id: number;
  submittedAt: string;
  status: 'approved' | 'changes-requested' | 'commented';
  headSha: string;
}): MergerReviewArtifact {
  return {
    id: input.id,
    body: [
      '🤖 Agent review (reviewer)',
      '',
      '<!-- AGENT-METADATA',
      'agent-id: reviewer',
      'agent-stage: reviewer',
      `status: ${input.status}`,
      `head-sha: ${input.headSha}`,
      `timestamp: ${input.submittedAt}`,
      '-->',
    ].join('\n'),
    submittedAt: input.submittedAt,
    state: input.status === 'approved' ? 'APPROVED' : input.status === 'changes-requested' ? 'CHANGES_REQUESTED' : 'COMMENTED',
    authorLogin: 'github-actions[bot]',
  };
}

function buildReviewThread(input: {
  id: string;
  isResolved: boolean;
  comments?: MergerReviewThread['comments'];
}): MergerReviewThread {
  return {
    id: input.id,
    isResolved: input.isResolved,
    comments: input.comments ?? [],
  };
}

function buildReviewThreadComment(input: {
  id: string;
  body: string;
  updatedAt: string;
  authorLogin: string;
}): MergerReviewThread['comments'][number] {
  return {
    id: input.id,
    body: input.body,
    updatedAt: input.updatedAt,
    authorLogin: input.authorLogin,
  };
}

function buildReviewerThreadMetadataComment(input: {
  status: 'approved' | 'changes-requested' | 'commented';
  headSha: string;
  timestamp: string;
}): string {
  return [
    '🤖 Agent review (reviewer)',
    '',
    '<!-- AGENT-METADATA',
    'agent-id: reviewer',
    'agent-stage: reviewer',
    `status: ${input.status}`,
    `head-sha: ${input.headSha}`,
    `timestamp: ${input.timestamp}`,
    '-->',
  ].join('\n');
}

function buildReviewingComment(input: {
  headSha: string;
  timestamp: string;
}): MergerThreadComment {
  return {
    id: 500,
    body: [
      '🤖 Agent note (reviewer)',
      '',
      '<!-- AGENT-METADATA',
      'agent-id: reviewer',
      'agent-stage: reviewer',
      'status: reviewing',
      `head-sha: ${input.headSha}`,
      `timestamp: ${input.timestamp}`,
      '-->',
    ].join('\n'),
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    authorLogin: 'github-actions[bot]',
  };
}
