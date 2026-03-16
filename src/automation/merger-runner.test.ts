import { describe, expect, it } from 'vitest';
import {
  buildMergeGateEvaluationComment,
  evaluateMergeGate,
  shouldSkipMergerByLabels,
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

    it('blocks draft or explicitly blocked PRs even before reviewer and CI checks are satisfied', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 167,
          headSha: 'abc123',
          draft: true,
          labels: ['agent:review:required', 'agent:blocked'],
        }),
        threadComments: [],
        reviews: [],
        reviewThreads: [],
        ciChecks: [],
      });

      expect(evaluation.ready).toBe(false);
      expect(evaluation.reasons).toEqual(expect.arrayContaining([
        'draft-pr',
        'agent-blocked',
        'missing-current-approval',
        'ci-not-green',
      ]));
    });

    it('ignores missing or ignore-for-workflow reviewer metadata when evaluating approvals', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 168,
          headSha: 'abc123',
          labels: ['agent:review:required'],
        }),
        threadComments: [
          {
            id: 50,
            body: 'plain human note without metadata',
            createdAt: '2026-03-14T17:50:00Z',
            updatedAt: '2026-03-14T17:50:00Z',
            authorLogin: 'human-reviewer',
          },
        ],
        reviews: [{
          id: 51,
          body: [
            'Ignored reviewer decision',
            '<!-- AGENT-METADATA',
            'agent-stage: reviewer',
            'status: approved',
            'head-sha: abc123',
            'ignore-for-workflow: true',
            '-->',
          ].join('\n'),
          submittedAt: '2026-03-14T17:55:00Z',
          state: 'APPROVED',
          authorLogin: 'github-actions[bot]',
        }],
        reviewThreads: [],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      });

      expect(evaluation.ready).toBe(false);
      expect(evaluation.reasons).toContain('missing-current-approval');
    });

    it('fails closed on invalid merger event timestamps and exposes simple label-only skip checks', () => {
      expect(() => evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 169,
          headSha: 'abc123',
          labels: ['agent:review:required'],
        }),
        threadComments: [],
        reviews: [
          {
            id: 52,
            body: buildReviewerThreadMetadataComment({
              status: 'approved',
              headSha: 'abc123',
              timestamp: '2026-03-14T17:55:00Z',
            }),
            submittedAt: '2026-03-14T17:54:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          },
          {
            id: 53,
            body: buildReviewerThreadMetadataComment({
              status: 'commented',
              headSha: 'abc123',
              timestamp: '2026-03-14T17:56:00Z',
            }),
            submittedAt: 'not-a-timestamp',
            state: 'COMMENTED',
            authorLogin: 'github-actions[bot]',
          },
        ],
        reviewThreads: [],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      })).toThrow('Invalid timestamp: not-a-timestamp');

      expect(shouldSkipMergerByLabels(['human:hold'])).toBe(true);
      expect(shouldSkipMergerByLabels(['agent:review:required'])).toBe(false);
    });

    it('does not mark follow-up pending when reviewer-owned thread timestamps are blank or have no newer external reply', () => {
      const blankAgentTimestamp = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 170,
          headSha: 'abc123',
          labels: ['agent:review:required', 'agent:review:done'],
        }),
        threadComments: [],
        reviews: [buildReview({
          id: 53,
          submittedAt: '2026-03-14T17:55:00Z',
          status: 'approved',
          headSha: 'abc123',
        })],
        reviewThreads: [buildReviewThread({
          id: 'thread-blank-agent-time',
          isResolved: true,
          comments: [
            buildReviewThreadComment({
              id: 'agent-empty',
              authorLogin: 'github-actions[bot]',
              updatedAt: '',
              body: buildReviewerThreadMetadataComment({
                status: 'commented',
                headSha: 'abc123',
                timestamp: '2026-03-14T17:40:00Z',
              }),
            }),
          ],
        })],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      });

      const noNewerExternalReply = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 171,
          headSha: 'abc123',
          labels: ['agent:review:required', 'agent:review:done'],
        }),
        threadComments: [],
        reviews: [buildReview({
          id: 54,
          submittedAt: '2026-03-14T17:55:00Z',
          status: 'approved',
          headSha: 'abc123',
        })],
        reviewThreads: [buildReviewThread({
          id: 'thread-no-external-reply',
          isResolved: true,
          comments: [
            buildReviewThreadComment({
              id: 'agent-comment',
              authorLogin: 'github-actions[bot]',
              updatedAt: '2026-03-14T17:40:00Z',
              body: buildReviewerThreadMetadataComment({
                status: 'commented',
                headSha: 'abc123',
                timestamp: '2026-03-14T17:40:00Z',
              }),
            }),
          ],
        })],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      });

      expect(blankAgentTimestamp.reasons).not.toContain('review-follow-up-pending');
      expect(noNewerExternalReply.reasons).not.toContain('review-follow-up-pending');
    });

    it('flags follow-up pending when newer human replies exist before any terminal reviewer decision timestamp is available', () => {
      const evaluation = evaluateMergeGate({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merger',
        runId: 'run-123',
        timestamp: '2026-03-14T18:00:00Z',
        leaseTtlMinutes: 45,
        pullRequest: buildPullRequest({
          number: 172,
          headSha: 'abc123',
          labels: [],
        }),
        threadComments: [],
        reviews: [],
        reviewThreads: [buildReviewThread({
          id: 'thread-no-terminal-decision',
          isResolved: true,
          comments: [
            buildReviewThreadComment({
              id: 'agent-comment-1',
              authorLogin: 'github-actions[bot]',
              updatedAt: '2026-03-14T17:40:00Z',
              body: buildReviewerThreadMetadataComment({
                status: 'commented',
                headSha: 'abc123',
                timestamp: '2026-03-14T17:40:00Z',
              }),
            }),
            buildReviewThreadComment({
              id: 'human-comment-1',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-14T17:50:00Z',
              body: 'Please confirm the fallback path.',
            }),
            buildReviewThreadComment({
              id: 'human-comment-2',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-14T17:52:00Z',
              body: 'And verify retries stay bounded.',
            }),
          ],
        })],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      });

      expect(evaluation.reasons).toContain('review-follow-up-pending');
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
