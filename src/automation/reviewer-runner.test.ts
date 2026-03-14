import { describe, expect, it } from 'vitest';
import {
  buildReviewerLeaseComment,
  collectReviewerAssignments,
  hasActiveReviewerLease,
  type ReviewerPullRequest,
  type ReviewerReviewArtifact,
  type ReviewerThreadComment,
} from './reviewer-runner.js';

describe('reviewer-runner', () => {
  describe('hasActiveReviewerLease', () => {
    it('treats a current-head reviewing comment within TTL as an active lease', () => {
      const comments: ReviewerThreadComment[] = [
        {
          id: 700,
          body: [
            '🤖 Agent note (reviewer)',
            '',
            '<!-- AGENT-METADATA',
            'agent-id: reviewer',
            'agent-stage: reviewer',
            'status: reviewing',
            'head-sha: abc123',
            'timestamp: 2026-03-14T16:00:00Z',
            '-->',
          ].join('\n'),
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:00:00Z',
          authorLogin: 'github-actions[bot]',
        },
      ];

      expect(hasActiveReviewerLease({
        threadComments: comments,
        reviews: [],
        currentHeadSha: 'abc123',
        now: '2026-03-14T16:20:00Z',
        leaseTtlMinutes: 30,
      })).toBe(true);
    });

    it('ignores expired or stale-head reviewer leases', () => {
      const comments: ReviewerThreadComment[] = [
        {
          id: 701,
          body: [
            '🤖 Agent note (reviewer)',
            '',
            '<!-- AGENT-METADATA',
            'agent-id: reviewer',
            'agent-stage: reviewer',
            'status: reviewing',
            'head-sha: old-sha',
            'timestamp: 2026-03-14T15:00:00Z',
            '-->',
          ].join('\n'),
          createdAt: '2026-03-14T15:00:00Z',
          updatedAt: '2026-03-14T15:00:00Z',
          authorLogin: 'github-actions[bot]',
        },
      ];

      expect(hasActiveReviewerLease({
        threadComments: comments,
        reviews: [],
        currentHeadSha: 'new-sha',
        now: '2026-03-14T16:20:00Z',
        leaseTtlMinutes: 30,
      })).toBe(false);
    });
  });

  describe('collectReviewerAssignments', () => {
    it('selects a PR with required review and no current reviewer decision', () => {
      const pullRequests: ReviewerPullRequest[] = [
        buildPullRequest({ number: 156, headSha: 'abc123', labels: ['agent:created', 'agent:review:required'] }),
      ];

      const assignments = collectReviewerAssignments({
        pullRequests,
        commentsByPrNumber: { 156: [] },
        reviewsByPrNumber: { 156: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([
        expect.objectContaining({
          pullRequestNumber: 156,
          reason: 'missing-current-review',
        }),
      ]);
      expect(assignments[0]?.leaseCommentBody).toContain('status: reviewing');
      expect(assignments[0]?.leaseCommentBody).toContain('head-sha: abc123');
    });

    it('skips PRs with a current-head approved review', () => {
      const pullRequests: ReviewerPullRequest[] = [
        buildPullRequest({ number: 156, headSha: 'abc123', labels: ['agent:review:required'] }),
      ];
      const reviewsByPrNumber: Record<number, ReviewerReviewArtifact[]> = {
        156: [
          {
            id: 900,
            body: [
              'Looks good.',
              '<!-- AGENT-METADATA',
              'agent-id: reviewer',
              'agent-stage: reviewer',
              'status: approved',
              'head-sha: abc123',
              'timestamp: 2026-03-14T16:05:00Z',
              '-->',
            ].join('\n'),
            submittedAt: '2026-03-14T16:05:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          },
        ],
      };

      expect(collectReviewerAssignments({
        pullRequests,
        commentsByPrNumber: { 156: [] },
        reviewsByPrNumber,
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      })).toEqual([]);
    });

    it('requeues a PR when only a stale-head review exists', () => {
      const pullRequests: ReviewerPullRequest[] = [
        buildPullRequest({ number: 156, headSha: 'new-sha', labels: ['agent:review:required'] }),
      ];
      const reviewsByPrNumber: Record<number, ReviewerReviewArtifact[]> = {
        156: [
          {
            id: 901,
            body: [
              'Approved previous revision.',
              '<!-- AGENT-METADATA',
              'agent-id: reviewer',
              'agent-stage: reviewer',
              'status: approved',
              'head-sha: old-sha',
              'timestamp: 2026-03-14T15:05:00Z',
              '-->',
            ].join('\n'),
            submittedAt: '2026-03-14T15:05:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          },
        ],
      };

      const assignments = collectReviewerAssignments({
        pullRequests,
        commentsByPrNumber: { 156: [] },
        reviewsByPrNumber,
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([
        expect.objectContaining({
          pullRequestNumber: 156,
          reason: 'stale-review',
        }),
      ]);
    });

    it('skips PRs with an active review lease, draft state, or blocking labels', () => {
      const pullRequests: ReviewerPullRequest[] = [
        buildPullRequest({ number: 156, headSha: 'abc123', labels: ['agent:review:required'], draft: true }),
        buildPullRequest({ number: 157, headSha: 'abc123', labels: ['agent:review:required', 'human:hold'] }),
        buildPullRequest({ number: 158, headSha: 'abc123', labels: ['agent:review:required', 'agent:blocked'] }),
        buildPullRequest({ number: 159, headSha: 'abc123', labels: ['agent:review:required', 'agent:review:in-progress'] }),
      ];
      const commentsByPrNumber: Record<number, ReviewerThreadComment[]> = {
        156: [],
        157: [],
        158: [],
        159: [
          {
            id: 702,
            body: [
              '🤖 Agent note (reviewer)',
              '',
              '<!-- AGENT-METADATA',
              'agent-id: reviewer',
              'agent-stage: reviewer',
              'status: reviewing',
              'head-sha: abc123',
              'timestamp: 2026-03-14T16:00:00Z',
              '-->',
            ].join('\n'),
            createdAt: '2026-03-14T16:00:00Z',
            updatedAt: '2026-03-14T16:00:00Z',
            authorLogin: 'github-actions[bot]',
          },
        ],
      };

      expect(collectReviewerAssignments({
        pullRequests,
        commentsByPrNumber,
        reviewsByPrNumber: { 156: [], 157: [], 158: [], 159: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      })).toEqual([]);
    });
  });

  describe('buildReviewerLeaseComment', () => {
    it('includes visible agent disclosure and machine-readable lease metadata', () => {
      const comment = buildReviewerLeaseComment({
        repository: 'davidruzicka/mcp4openapi',
        pullRequestNumber: 156,
        headSha: 'abc123',
        agentId: 'reviewer',
        runId: 'run-123',
        timestamp: '2026-03-14T16:10:00Z',
        reason: 'stale-review',
      });

      expect(comment).toContain('🤖 Agent note (reviewer)');
      expect(comment).toContain('reason: stale-review');
      expect(comment).toContain('agent-stage: reviewer');
      expect(comment).toContain('pr-number: 156');
      expect(comment).toContain('head-sha: abc123');
      expect(comment).toContain('status: reviewing');
    });
  });
});

function buildPullRequest(input: {
  number: number;
  headSha: string;
  labels: readonly string[];
  draft?: boolean;
}): ReviewerPullRequest {
  return {
    number: input.number,
    title: `PR ${input.number}`,
    body: 'Autonomous PR body',
    url: `https://github.com/davidruzicka/mcp4openapi/pull/${input.number}`,
    draft: input.draft ?? false,
    headSha: input.headSha,
    updatedAt: '2026-03-14T16:00:00Z',
    labels: input.labels,
  };
}
