import { describe, expect, it } from 'vitest';
import {
  buildImplementorLeaseComment,
  buildImplementorResultComment,
  collectImplementorAssignments,
  parseImplementorCommandResult,
  planImplementorResultLabels,
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

    it('requeues issues once an implementor lease has expired', () => {
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
        openPullRequestsByIssueNumber: {},
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'implementor',
        runId: 'run-3',
        now: '2026-03-14T13:00:01Z',
        leaseTtlMinutes: 60,
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.issueNumber).toBe(161);
    });

    it('rejects invalid timestamps in lease comments so automation fails closed', () => {
      const assignments = () => collectImplementorAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: {
          161: [buildComment([
            '🤖 Agent implementation note (implementor)',
            '',
            '<!-- AGENT-METADATA',
            'agent-stage: implementor',
            'status: implementing',
            '-->',
          ].join('\n'))],
        },
        openPullRequestsByIssueNumber: {},
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'implementor',
        runId: 'run-3',
        now: 'not-a-timestamp',
      });

      expect(assignments).toThrow('Invalid timestamp: not-a-timestamp');
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
      expect(() => parseImplementorCommandResult('not-json')).toThrow('expected JSON object');
      expect(() => parseImplementorCommandResult('[]')).toThrow('unsupported outcome');
      expect(() => parseImplementorCommandResult('null')).toThrow('expected object payload');
      expect(() => parseImplementorCommandResult('{"outcome":"unknown","summary":"x"}')).toThrow('unsupported outcome');
      expect(() => parseImplementorCommandResult('{"outcome":"blocked","summary":""}')).toThrow('missing summary');
      expect(() => parseImplementorCommandResult('{"outcome":"blocked","summary":"x","pullRequest":null}')).toThrow('invalid pullRequest payload');
      expect(() => parseImplementorCommandResult('{"outcome":"pr-created","summary":"x"}')).toThrow('pr-created outcome requires pullRequest metadata');
    });
  });

  describe('planImplementorResultLabels', () => {
    it('adds blocked workflow labels when implementation cannot proceed', () => {
      expect(planImplementorResultLabels({ outcome: 'blocked', summary: 'Needs a human decision.' })).toEqual({
        issueLabelsToAdd: ['agent:blocked'],
        issueLabelsToRemove: ['agent:implementing'],
        pullRequestLabelsToAdd: [],
      });
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
