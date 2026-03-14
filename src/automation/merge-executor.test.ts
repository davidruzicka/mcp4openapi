import { describe, expect, it } from 'vitest';
import {
  buildMergeExecutionComment,
  planMergeExecution,
  type FinalMergeReason,
} from './merge-executor.js';
import {
  type MergerCiCheck,
  type MergerPullRequest,
  type MergerReviewArtifact,
  type MergerReviewThread,
  type MergerThreadComment,
} from './merger-runner.js';

describe('merge-executor', () => {
  describe('planMergeExecution', () => {
    it('returns a merge plan only when ready label, current-head approval, resolved threads, and green CI still hold', () => {
      const execution = planMergeExecution({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merge-executor',
        runId: 'run-456',
        timestamp: '2026-03-14T19:00:00Z',
        leaseTtlMinutes: 45,
        expectedHeadSha: 'abc123',
        pullRequest: buildPullRequest({
          number: 170,
          headSha: 'abc123',
          labels: ['agent:created', 'agent:review:required', 'agent:review:done', 'agent:ready-to-merge'],
        }),
        threadComments: [],
        reviews: [buildReview({ id: 1, submittedAt: '2026-03-14T18:55:00Z', status: 'approved', headSha: 'abc123' })],
        reviewThreads: [{ id: 'thread-1', isResolved: true }],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      });

      expect(execution.shouldMerge).toBe(true);
      expect(execution.reasons).toEqual([]);
      expect(execution.mergeMethod).toBe('squash');
      expect(execution.labelsToRemove).toContain('agent:ready-to-merge');
      expect(execution.commentBody).toContain('status: merged');
      expect(execution.commentBody).toContain('merge-method: squash');
    });

    it('skips merge and clears ready label when the current head sha no longer matches the lease candidate', () => {
      const execution = planMergeExecution({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merge-executor',
        runId: 'run-456',
        timestamp: '2026-03-14T19:00:00Z',
        leaseTtlMinutes: 45,
        expectedHeadSha: 'old-sha',
        pullRequest: buildPullRequest({
          number: 171,
          headSha: 'new-sha',
          labels: ['agent:review:required', 'agent:review:done', 'agent:ready-to-merge'],
        }),
        threadComments: [],
        reviews: [buildReview({ id: 2, submittedAt: '2026-03-14T18:55:00Z', status: 'approved', headSha: 'new-sha' })],
        reviewThreads: [],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      });

      expect(execution.shouldMerge).toBe(false);
      expect(execution.reasons).toEqual(['head-sha-changed']);
      expect(execution.labelsToRemove).toContain('agent:ready-to-merge');
      expect(execution.commentBody).toContain('expected-head-sha: old-sha');
      expect(execution.commentBody).toContain('status: skipped');
    });

    it('skips merge when the ready label is missing even if the deterministic gates are otherwise green', () => {
      const execution = planMergeExecution({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merge-executor',
        runId: 'run-456',
        timestamp: '2026-03-14T19:00:00Z',
        leaseTtlMinutes: 45,
        expectedHeadSha: 'abc123',
        pullRequest: buildPullRequest({
          number: 172,
          headSha: 'abc123',
          labels: ['agent:review:required', 'agent:review:done'],
        }),
        threadComments: [],
        reviews: [buildReview({ id: 3, submittedAt: '2026-03-14T18:55:00Z', status: 'approved', headSha: 'abc123' })],
        reviewThreads: [],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      });

      expect(execution.shouldMerge).toBe(false);
      expect(execution.reasons).toEqual(['missing-ready-label']);
      expect(execution.commentBody).toContain('missing-ready-label');
    });

    it('skips merge and removes ready label when final revalidation detects a new hold or failing gate', () => {
      const execution = planMergeExecution({
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'merge-executor',
        runId: 'run-456',
        timestamp: '2026-03-14T19:00:00Z',
        leaseTtlMinutes: 45,
        expectedHeadSha: 'abc123',
        pullRequest: buildPullRequest({
          number: 173,
          headSha: 'abc123',
          labels: ['agent:review:required', 'agent:review:done', 'agent:ready-to-merge', 'human:hold'],
        }),
        threadComments: [],
        reviews: [buildReview({ id: 4, submittedAt: '2026-03-14T18:55:00Z', status: 'approved', headSha: 'abc123' })],
        reviewThreads: [{ id: 'thread-1', isResolved: false }],
        ciChecks: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
      });

      expect(execution.shouldMerge).toBe(false);
      expect(execution.reasons).toEqual(expect.arrayContaining<FinalMergeReason>([
        'human-hold',
        'unresolved-review-threads',
        'ci-not-green',
      ]));
      expect(execution.labelsToRemove).toContain('agent:ready-to-merge');
      expect(execution.commentBody).toContain('status: skipped');
    });
  });

  describe('buildMergeExecutionComment', () => {
    it('includes visible agent disclosure plus machine-readable merge executor metadata', () => {
      const comment = buildMergeExecutionComment({
        repository: 'davidruzicka/mcp4openapi',
        pullRequestNumber: 174,
        headSha: 'merge123',
        expectedHeadSha: 'merge123',
        agentId: 'merge-executor',
        runId: 'run-456',
        timestamp: '2026-03-14T19:00:00Z',
        shouldMerge: false,
        mergeMethod: 'squash',
        summary: 'Final merge execution skipped because deterministic merge gates changed.',
        reasons: ['ci-not-green'],
      });

      expect(comment).toContain('🤖 Agent note (merge-executor)');
      expect(comment).toContain('status: skipped');
      expect(comment).toContain('merge-method: squash');
      expect(comment).toContain('expected-head-sha: merge123');
      expect(comment).toContain('Reasons: ci-not-green');
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
    updatedAt: '2026-03-14T18:55:00Z',
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
