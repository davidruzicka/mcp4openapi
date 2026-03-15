import { describe, expect, it } from 'vitest';
import {
  buildImplementorLeaseComment,
  buildImplementorResultComment,
  collectImplementorAssignments,
  parseImplementorCommandResult,
  type ImplementorIssue,
  type ImplementorIssueComment,
} from './implementor-runner.js';

function buildIssue(overrides: Partial<ImplementorIssue> = {}): ImplementorIssue {
  return {
    number: 161,
    title: 'Add cache invalidation metrics',
    body: 'Need bounded instrumentation and tests.',
    url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
    updatedAt: '2026-03-14T12:00:00Z',
    labels: ['agent:safe', 'agent:planned'],
    ...overrides,
  };
}

function buildComment(body: string): ImplementorIssueComment {
  return {
    id: 1,
    body,
    createdAt: '2026-03-14T12:00:00Z',
    updatedAt: '2026-03-14T12:00:00Z',
    authorLogin: 'github-actions[bot]',
  };
}

describe('implementor-runner', () => {
  describe('collectImplementorAssignments', () => {
    it('queues safe planned issues without open pull requests', () => {
      const assignments = collectImplementorAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: { 161: [] },
        openPullRequestsByIssueNumber: {},
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'implementor',
        runId: 'run-3',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        issueNumber: 161,
        labelsToAdd: ['agent:implementing'],
        labelsToRemove: ['agent:blocked'],
      });
      expect(assignments[0]?.leaseCommentBody).toContain('🤖 Agent implementation note (implementor)');
      expect(assignments[0]?.leaseCommentBody).toContain('status: implementing');
    });

    it('skips issues with an open pull request or an active lease comment', () => {
      const leaseComment = buildImplementorLeaseComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 161,
        agentId: 'implementor',
        runId: 'run-3',
        timestamp: '2026-03-14T12:00:00Z',
      });

      const assignments = collectImplementorAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: { 161: [buildComment(leaseComment)] },
        openPullRequestsByIssueNumber: { 161: 201 },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'implementor',
        runId: 'run-3',
        now: '2026-03-14T12:15:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toHaveLength(0);
    });
  });

  describe('parseImplementorCommandResult', () => {
    it('parses a successful PR creation payload', () => {
      expect(parseImplementorCommandResult(JSON.stringify({
        outcome: 'pr-created',
        summary: 'Created a PR with targeted tests.',
        pullRequest: {
          number: 201,
          url: 'https://github.com/davidruzicka/mcp4openapi/pull/201',
        },
      }))).toEqual({
        outcome: 'pr-created',
        summary: 'Created a PR with targeted tests.',
        pullRequest: {
          number: 201,
          url: 'https://github.com/davidruzicka/mcp4openapi/pull/201',
        },
      });
    });

    it('rejects invalid payloads', () => {
      expect(() => parseImplementorCommandResult('{"summary":"missing outcome"}')).toThrow('Invalid implementor command result');
    });
  });

  describe('buildImplementorResultComment', () => {
    it('includes structured metadata for successful PR creation', () => {
      const comment = buildImplementorResultComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 161,
        agentId: 'implementor',
        runId: 'run-3',
        timestamp: '2026-03-14T12:30:00Z',
        result: {
          outcome: 'pr-created',
          summary: 'Created PR #201 with tests.',
          pullRequest: {
            number: 201,
            url: 'https://github.com/davidruzicka/mcp4openapi/pull/201',
          },
        },
      });

      expect(comment).toContain('🤖 Agent implementation note (implementor)');
      expect(comment).toContain('status: pr-created');
      expect(comment).toContain('PR: #201');
    });
  });
});
