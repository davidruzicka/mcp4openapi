import { describe, expect, it } from 'vitest';
import {
  buildReviewerLeaseComment,
  buildSemanticReviewerDecision,
  collectReviewerAssignments,
  hasActiveReviewerLease,
  type ReviewerChangedFile,
  type ReviewerPullRequest,
  type ReviewerReviewArtifact,
  type ReviewerReviewThread,
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
        reviewThreadsByPrNumber: { 156: [] },
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
        reviewThreadsByPrNumber: { 156: [] },
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
        reviewThreadsByPrNumber: { 156: [] },
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

    it('requeues a PR when reviewer-owned thread replies arrived after the last current-head decision', () => {
      const pullRequests: ReviewerPullRequest[] = [
        buildPullRequest({ number: 156, headSha: 'abc123', labels: ['agent:review:required'] }),
      ];
      const reviewsByPrNumber: Record<number, ReviewerReviewArtifact[]> = {
        156: [
          {
            id: 902,
            body: buildReviewerMetadataComment({ status: 'approved', headSha: 'abc123', timestamp: '2026-03-14T16:05:00Z' }),
            submittedAt: '2026-03-14T16:05:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          },
        ],
      };
      const reviewThreadsByPrNumber: Record<number, ReviewerReviewThread[]> = {
        156: [
          buildReviewThread({
            id: 'thread-1',
            isResolved: true,
            comments: [
              buildReviewThreadComment({
                id: 'comment-1',
                authorLogin: 'github-actions[bot]',
                updatedAt: '2026-03-14T16:00:00Z',
                body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T16:00:00Z' }),
              }),
              buildReviewThreadComment({
                id: 'comment-2',
                authorLogin: 'human-reviewer',
                updatedAt: '2026-03-14T16:08:00Z',
                body: 'Can you also verify the fallback path?',
              }),
            ],
          }),
        ],
      };

      const assignments = collectReviewerAssignments({
        pullRequests,
        commentsByPrNumber: { 156: [] },
        reviewsByPrNumber,
        reviewThreadsByPrNumber,
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([
        expect.objectContaining({
          pullRequestNumber: 156,
          reason: 'follow-up-requested',
        }),
      ]);
    });

    it('uses the latest current-head reviewer decision timestamp when multiple decisions exist', () => {
      const pullRequests: ReviewerPullRequest[] = [
        buildPullRequest({ number: 156, headSha: 'abc123', labels: ['agent:review:required'] }),
      ];
      const reviewsByPrNumber: Record<number, ReviewerReviewArtifact[]> = {
        156: [
          {
            id: 902,
            body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T16:05:00Z' }),
            submittedAt: '2026-03-14T16:05:00Z',
            state: 'COMMENTED',
            authorLogin: 'github-actions[bot]',
          },
          {
            id: 901,
            body: buildReviewerMetadataComment({ status: 'approved', headSha: 'abc123', timestamp: '2026-03-14T16:00:00Z' }),
            submittedAt: '2026-03-14T16:00:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          },
        ],
      };
      const reviewThreadsByPrNumber: Record<number, ReviewerReviewThread[]> = {
        156: [
          buildReviewThread({
            id: 'thread-1',
            isResolved: false,
            comments: [
              buildReviewThreadComment({
                id: 'comment-1',
                authorLogin: 'github-actions[bot]',
                updatedAt: '2026-03-14T15:55:00Z',
                body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T15:55:00Z' }),
              }),
              buildReviewThreadComment({
                id: 'comment-2',
                authorLogin: 'human-reviewer',
                updatedAt: '2026-03-14T16:03:00Z',
                body: 'Looks good now.',
              }),
            ],
          }),
        ],
      };

      expect(collectReviewerAssignments({
        pullRequests,
        commentsByPrNumber: { 156: [] },
        reviewsByPrNumber,
        reviewThreadsByPrNumber,
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      })).toEqual([]);
    });

    it('skips follow-up requeue when reviewer thread has no newer external reply', () => {
      const pullRequests: ReviewerPullRequest[] = [
        buildPullRequest({ number: 156, headSha: 'abc123', labels: ['agent:review:required'] }),
      ];
      const reviewsByPrNumber: Record<number, ReviewerReviewArtifact[]> = {
        156: [
          {
            id: 902,
            body: buildReviewerMetadataComment({ status: 'approved', headSha: 'abc123', timestamp: '2026-03-14T16:05:00Z' }),
            submittedAt: '2026-03-14T16:05:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          },
        ],
      };
      const reviewThreadsByPrNumber: Record<number, ReviewerReviewThread[]> = {
        156: [
          buildReviewThread({
            id: 'thread-1',
            isResolved: false,
            comments: [
              buildReviewThreadComment({
                id: 'comment-1',
                authorLogin: 'github-actions[bot]',
                updatedAt: '2026-03-14T16:00:00Z',
                body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T16:00:00Z' }),
              }),
            ],
          }),
        ],
      };

      expect(collectReviewerAssignments({
        pullRequests,
        commentsByPrNumber: { 156: [] },
        reviewsByPrNumber,
        reviewThreadsByPrNumber,
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      })).toEqual([]);
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
        reviewThreadsByPrNumber: { 156: [], 157: [], 158: [], 159: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      })).toEqual([]);
    });

    it('ignores follow-up requeue logic when reviewer threads only contain other people or stale metadata', () => {
      const assignments = collectReviewerAssignments({
        pullRequests: [buildPullRequest({ number: 161, headSha: 'abc123', labels: ['agent:review:required'] })],
        commentsByPrNumber: { 161: [] },
        reviewsByPrNumber: {
          161: [{
            id: 903,
            body: buildReviewerMetadataComment({ status: 'approved', headSha: 'abc123', timestamp: '2026-03-14T16:05:00Z' }),
            submittedAt: '2026-03-14T16:05:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          }],
        },
        reviewThreadsByPrNumber: {
          161: [buildReviewThread({
            id: 'thread-no-agent-reply',
            isResolved: false,
            comments: [
              buildReviewThreadComment({
                id: 'comment-human',
                authorLogin: 'human-reviewer',
                updatedAt: '2026-03-14T16:08:00Z',
                body: 'Please revisit the fallback path.',
              }),
            ],
          })],
        },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([]);
    });

    it('requeues when external replies arrive after a reviewer thread comment but before any terminal decision', () => {
      const assignments = collectReviewerAssignments({
        pullRequests: [buildPullRequest({ number: 162, headSha: 'abc123', labels: ['agent:review:required'] })],
        commentsByPrNumber: { 162: [] },
        reviewsByPrNumber: { 162: [] },
        reviewThreadsByPrNumber: {
          162: [buildReviewThread({
            id: 'thread-pending-follow-up',
            isResolved: false,
            comments: [
              buildReviewThreadComment({
                id: 'comment-agent',
                authorLogin: 'github-actions[bot]',
                updatedAt: '2026-03-14T16:00:00Z',
                body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T16:00:00Z' }),
              }),
              buildReviewThreadComment({
                id: 'comment-human',
                authorLogin: 'human-reviewer',
                updatedAt: '2026-03-14T16:08:00Z',
                body: 'Please also cover the retry path.',
              }),
            ],
          })],
        },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([
        expect.objectContaining({
          pullRequestNumber: 162,
          reason: 'missing-current-review',
        }),
      ]);
    });

    it('fails closed when reviewer timestamps are invalid', () => {
      expect(() => collectReviewerAssignments({
        pullRequests: [buildPullRequest({ number: 163, headSha: 'abc123', labels: ['agent:review:required'] })],
        commentsByPrNumber: { 163: [] },
        reviewsByPrNumber: { 163: [] },
        reviewThreadsByPrNumber: { 163: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: 'not-a-timestamp',
        leaseTtlMinutes: 30,
      })).toThrow('Invalid timestamp: not-a-timestamp');
    });

    it('treats legacy reviewed and reviewing labels as migration-era review lane signals', () => {
      const assignments = collectReviewerAssignments({
        pullRequests: [
          buildPullRequest({ number: 160, headSha: 'legacy-sha', labels: ['agent:reviewed'] }),
        ],
        commentsByPrNumber: { 160: [] },
        reviewsByPrNumber: { 160: [] },
        reviewThreadsByPrNumber: { 160: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([
        expect.objectContaining({
          pullRequestNumber: 160,
          reason: 'missing-current-review',
        }),
      ]);
    });

    it('skips PRs without any review lifecycle signal even when they are otherwise eligible', () => {
      expect(collectReviewerAssignments({
        pullRequests: [buildPullRequest({ number: 164, headSha: 'abc123', labels: ['agent:created'] })],
        commentsByPrNumber: { 164: [] },
        reviewsByPrNumber: { 164: [] },
        reviewThreadsByPrNumber: { 164: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      })).toEqual([]);
    });

    it('fails open on malformed reviewer thread timestamps and only requeues when newer external replies exist', () => {
      expect(collectReviewerAssignments({
        pullRequests: [buildPullRequest({ number: 165, headSha: 'abc123', labels: ['agent:review:required'] })],
        commentsByPrNumber: { 165: [] },
        reviewsByPrNumber: {
          165: [{
            id: 904,
            body: buildReviewerMetadataComment({ status: 'approved', headSha: 'abc123', timestamp: '2026-03-14T16:05:00Z' }),
            submittedAt: '2026-03-14T16:05:00Z',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          }],
        },
        reviewThreadsByPrNumber: {
          165: [buildReviewThread({
            id: 'thread-malformed-agent-time',
            isResolved: false,
            comments: [
              buildReviewThreadComment({
                id: 'comment-agent-empty-time',
                authorLogin: 'github-actions[bot]',
                updatedAt: '',
                body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T16:00:00Z' }),
              }),
            ],
          })],
        },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      })).toEqual([]);
    });

    it('requeues when the latest reviewer decision timestamp is blank but a newer human reply exists', () => {
      const assignments = collectReviewerAssignments({
        pullRequests: [buildPullRequest({ number: 166, headSha: 'abc123', labels: ['agent:review:required'] })],
        commentsByPrNumber: { 166: [] },
        reviewsByPrNumber: {
          166: [{
            id: 905,
            body: buildReviewerMetadataComment({ status: 'approved', headSha: 'abc123', timestamp: '2026-03-14T16:05:00Z' }),
            submittedAt: '',
            state: 'APPROVED',
            authorLogin: 'github-actions[bot]',
          }],
        },
        reviewThreadsByPrNumber: {
          166: [buildReviewThread({
            id: 'thread-blank-decision-time',
            isResolved: false,
            comments: [
              buildReviewThreadComment({
                id: 'comment-agent-1',
                authorLogin: 'github-actions[bot]',
                updatedAt: '2026-03-14T16:00:00Z',
                body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T16:00:00Z' }),
              }),
              buildReviewThreadComment({
                id: 'comment-agent-2',
                authorLogin: 'github-actions[bot]',
                updatedAt: '2026-03-14T16:01:00Z',
                body: buildReviewerMetadataComment({ status: 'commented', headSha: 'abc123', timestamp: '2026-03-14T16:01:00Z' }),
              }),
              buildReviewThreadComment({
                id: 'comment-human-1',
                authorLogin: 'human-reviewer',
                updatedAt: '2026-03-14T16:08:00Z',
                body: 'Please also validate the retry path.',
              }),
              buildReviewThreadComment({
                id: 'comment-human-2',
                authorLogin: 'human-reviewer',
                updatedAt: '2026-03-14T16:09:00Z',
                body: 'And confirm the fallback summary.',
              }),
            ],
          })],
        },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([
        expect.objectContaining({
          pullRequestNumber: 166,
          reason: 'follow-up-requested',
        }),
      ]);
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

  describe('buildSemanticReviewerDecision', () => {
    it('requests changes when production code changes do not include targeted tests', () => {
      const decision = buildSemanticReviewerDecision({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        timestamp: '2026-03-14T16:10:00Z',
        pullRequest: buildPullRequest({
          number: 156,
          headSha: 'abc123',
          labels: ['agent:created', 'agent:review:required', 'agent:review:in-progress'],
          body: '## Summary\n\nRefactor auth runtime.',
        }),
        changedFiles: [
          buildChangedFile({ filename: 'src/transport/auth-runtime.ts' }),
          buildChangedFile({ filename: 'src/transport/http-client-factory.ts' }),
        ],
      });

      expect(decision.verdict).toBe('changes-requested');
      expect(decision.findings).toEqual([
        expect.objectContaining({
          category: 'missing-agent-disclosure',
        }),
        expect.objectContaining({
          category: 'missing-targeted-tests',
        }),
      ]);
      expect(decision.reviewBody).toContain('status: changes-requested');
      expect(decision.labelsToAdd).toEqual([]);
      expect(decision.labelsToRemove).toContain('agent:review:in-progress');
      expect(decision.labelsToRemove).toContain('agent:review:done');
    });

    it('approves docs-only changes with current-head reviewer metadata', () => {
      const decision = buildSemanticReviewerDecision({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        timestamp: '2026-03-14T16:10:00Z',
        pullRequest: buildPullRequest({
          number: 157,
          headSha: 'docsha',
          labels: ['agent:created', 'agent:review:required', 'agent:review:in-progress'],
          body: [
            '🤖 This PR was created by an automated agent.',
            '',
            '<!-- AGENT-METADATA',
            'agent-id: implementor',
            'agent-stage: implementor',
            'status: opened-pr',
            '-->',
          ].join('\n'),
        }),
        changedFiles: [
          buildChangedFile({ filename: 'docs/AUTONOMOUS-AGENTS.md' }),
          buildChangedFile({ filename: 'CHANGELOG.md' }),
        ],
      });

      expect(decision.verdict).toBe('approved');
      expect(decision.findings).toEqual([]);
      expect(decision.reviewBody).toContain('Docs-only changes look consistent and low risk.');
      expect(decision.reviewBody).toContain('status: approved');
    });

    it('requests changes when an automation-created PR body is missing agent disclosure', () => {
      const decision = buildSemanticReviewerDecision({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        timestamp: '2026-03-14T16:10:00Z',
        pullRequest: buildPullRequest({
          number: 158,
          headSha: 'abc123',
          labels: ['agent:created', 'agent:review:required', 'agent:review:in-progress'],
          body: 'Regular PR body without automation note.',
        }),
        changedFiles: [
          buildChangedFile({ filename: 'docs/AUTONOMOUS-AGENTS.md' }),
        ],
      });

      expect(decision.verdict).toBe('changes-requested');
      expect(decision.findings).toEqual([
        expect.objectContaining({
          category: 'missing-agent-disclosure',
        }),
      ]);
      expect(decision.reviewBody).toContain('automation-created PR is missing visible agent disclosure');
    });

    it('approves bounded production changes when agent disclosure and targeted tests are present', () => {
      const decision = buildSemanticReviewerDecision({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'reviewer',
        runId: 'run-123',
        timestamp: '2026-03-14T16:10:00Z',
        pullRequest: buildPullRequest({
          number: 159,
          headSha: 'clean-sha',
          labels: ['agent:created', 'agent:review:required', 'agent:review:in-progress'],
          body: '🤖 Automated agent update with targeted tests and bounded scope.',
        }),
        changedFiles: [
          buildChangedFile({ filename: 'src/automation/reviewer-runner.ts' }),
          buildChangedFile({ filename: 'src/automation/reviewer-runner.test.ts' }),
        ],
      });

      expect(decision.verdict).toBe('approved');
      expect(decision.findings).toEqual([]);
      expect(decision.reviewBody).toContain('Current PR head looks consistent with the bounded reviewer policy checks.');
    });
  });
});

function buildPullRequest(input: {
  number: number;
  headSha: string;
  labels: readonly string[];
  body?: string;
  draft?: boolean;
}): ReviewerPullRequest {
  return {
    number: input.number,
    title: `PR ${input.number}`,
    body: input.body ?? 'Autonomous PR body',
    url: `https://github.com/davidruzicka/mcp4openapi/pull/${input.number}`,
    draft: input.draft ?? false,
    headSha: input.headSha,
    updatedAt: '2026-03-14T16:00:00Z',
    labels: input.labels,
  };
}

function buildChangedFile(input: {
  filename: string;
  status?: ReviewerChangedFile['status'];
}): ReviewerChangedFile {
  return {
    filename: input.filename,
    status: input.status ?? 'modified',
    additions: 10,
    deletions: 2,
    changes: 12,
    patch: '@@ -1 +1 @@',
  };
}

function buildReviewThread(input: {
  id: string;
  isResolved: boolean;
  comments?: ReviewerReviewThread['comments'];
}): ReviewerReviewThread {
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
}): ReviewerReviewThread['comments'][number] {
  return {
    id: input.id,
    body: input.body,
    updatedAt: input.updatedAt,
    authorLogin: input.authorLogin,
  };
}

function buildReviewerMetadataComment(input: {
  status: 'reviewing' | 'approved' | 'changes-requested' | 'commented';
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
