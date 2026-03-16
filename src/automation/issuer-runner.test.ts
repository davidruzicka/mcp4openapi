import { describe, expect, it } from 'vitest';
import {
  buildIssuerDecisionComment,
  collectIssuerAssignments,
  evaluateIssueAutonomy,
  type IssuerIssue,
  type IssuerIssueComment,
} from './issuer-runner.js';

function buildIssue(overrides: Partial<IssuerIssue> = {}): IssuerIssue {
  return {
    number: 155,
    title: 'Add bounded cache invalidation metrics for response cache',
    body: [
      '## Summary',
      'Add a narrow metrics hook for cache invalidation counts.',
      '',
      '## Acceptance Criteria',
      '- [ ] expose invalidation counter',
      '- [ ] add targeted unit tests',
      '- [ ] document the metric',
    ].join('\n'),
    url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
    updatedAt: '2026-03-14T12:00:00Z',
    labels: [],
    isPullRequest: false,
    ...overrides,
  };
}

function buildComment(body: string): IssuerIssueComment {
  return {
    id: 1,
    body,
    createdAt: '2026-03-14T12:00:00Z',
    updatedAt: '2026-03-14T12:00:00Z',
    authorLogin: 'github-actions[bot]',
  };
}

describe('issuer-runner', () => {
  describe('evaluateIssueAutonomy', () => {
    it('accepts narrowly scoped issues with acceptance criteria and validation hints', () => {
      const decision = evaluateIssueAutonomy(buildIssue());

      expect(decision.suitable).toBe(true);
      expect(decision.reasons).toContain('issue includes explicit acceptance or validation structure');
      expect(decision.reasons).toContain('issue stays within bounded autonomous risk heuristics');
    });

    it('rejects risky or underspecified issues', () => {
      const risky = evaluateIssueAutonomy(buildIssue({
        title: 'Design OAuth tenant migration strategy',
        body: 'Need a broad migration design for OAuth tokens across tenants.',
      }));

      expect(risky.suitable).toBe(false);
      expect(risky.reasons).toContain('issue matches high-risk keywords that should stay in a human lane');
      expect(risky.reasons).toContain('issue lacks concrete acceptance or validation structure');
    });
  });

  describe('collectIssuerAssignments', () => {
    it('queues candidate issues that do not already have an equivalent issuer decision', () => {
      const assignments = collectIssuerAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: { 155: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        issueNumber: 155,
        suitable: true,
        labelsToAdd: ['agent:safe', 'agent:needs-plan'],
      });
      expect(assignments[0]?.commentBody).toContain('🤖 Agent note (issuer)');
      expect(assignments[0]?.commentBody).toContain('status: safe');
    });

    it('skips issues already sitting in the stable safe plus needs-plan lane without stale blocked labels', () => {
      const assignments = collectIssuerAssignments({
        issues: [buildIssue({ labels: ['agent:safe', 'agent:needs-plan'] })],
        commentsByIssueNumber: { 155: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toEqual([]);
    });

    it('marks exact open duplicates as unsafe before assigning agent:safe labels', () => {
      const assignments = collectIssuerAssignments({
        issues: [
          buildIssue(),
          buildIssue({
            number: 156,
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/156',
          }),
        ],
        commentsByIssueNumber: {
          155: [],
          156: [],
        },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(2);
      expect(assignments[0]).toMatchObject({
        issueNumber: 155,
        suitable: true,
        labelsToAdd: ['agent:safe', 'agent:needs-plan'],
      });
      expect(assignments[1]).toMatchObject({
        issueNumber: 156,
        suitable: false,
        labelsToAdd: [],
        labelsToRemove: ['agent:safe', 'agent:needs-plan'],
      });
      expect(assignments[1]?.commentBody).toContain('status: unsafe');
      expect(assignments[1]?.commentBody).toContain('issue appears to duplicate existing open issue #155');
      expect(assignments[1]?.commentBody).toContain('Duplicate guard scope: exact open-title matches only; near-duplicates, follow-ups, and regressions stay in proposal-intake.');
    });

    it('keeps the earliest matching issue safe and blocks only later normalized-title duplicates', () => {
      const assignments = collectIssuerAssignments({
        issues: [
          buildIssue(),
          buildIssue({
            number: 156,
            title: 'Add bounded cache invalidation metrics for response cache!!!',
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/156',
          }),
        ],
        commentsByIssueNumber: {
          155: [],
          156: [],
        },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toMatchObject([
        {
          issueNumber: 155,
          suitable: true,
          labelsToAdd: ['agent:safe', 'agent:needs-plan'],
          labelsToRemove: ['agent:blocked'],
        },
        {
          issueNumber: 156,
          suitable: false,
          labelsToAdd: [],
          labelsToRemove: ['agent:safe', 'agent:needs-plan'],
          reasons: [
            'issue includes explicit acceptance or validation structure',
            'issue stays within bounded autonomous risk heuristics',
            'issue appears to duplicate existing open issue #155',
          ],
        },
      ]);
    });

    it('does not treat punctuation-only normalized titles as duplicates', () => {
      const assignments = collectIssuerAssignments({
        issues: [
          buildIssue({ number: 190, title: '!!!', url: 'https://github.com/davidruzicka/mcp4openapi/issues/190' }),
        ],
        commentsByIssueNumber: { 190: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.issueNumber).toBe(190);
    });

    it('skips pull requests, held issues, proposal-intake-gated issues, and already-commented equivalent decisions', () => {
      const commentBody = buildIssuerDecisionComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 155,
        agentId: 'issuer',
        runId: 'run-1',
        timestamp: '2026-03-14T12:00:00Z',
        suitable: true,
        reasons: ['issue includes explicit acceptance or validation structure'],
      });
      const proposalIntakeComment = [
        '🤖 Agent note (proposal-intake)',
        '',
        'Resolution: create-fresh',
        'Reason: no relevant existing issue or pull request matches this proposal',
        '',
        '<!-- AGENT-METADATA',
        'agent-id: proposal-intake',
        'agent-stage: proposal-intake',
        'resolution: create-fresh',
        'proposal-key: add-bounded-cache-invalidation-metrics-for-response-cache',
        '-->',
      ].join('\n');

      const assignments = collectIssuerAssignments({
        issues: [
          buildIssue({ isPullRequest: true }),
          buildIssue({ number: 156, labels: ['human:hold'] }),
          buildIssue({ number: 157 }),
          buildIssue(),
        ],
        commentsByIssueNumber: {
          155: [buildComment(commentBody)],
          156: [],
          157: [buildComment(proposalIntakeComment)],
        },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(0);
    });

    it('skips issues already created by proposal-intake when metadata lives in the issue body', () => {
      const createdByProposalIntakeBody = [
        'Need a bounded warning threshold metric and focused tests.',
        '',
        'Source proposal: #177',
        'Source URL: https://example.com/proposals/profile-routing-warnings',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: proposal-intake',
        'agent-role: created-issue',
        'source-issue-number: 177',
        'proposal-key: add-profile-routing-observability-budget-warnings',
        '-->',
      ].join('\n');

      const assignments = collectIssuerAssignments({
        issues: [buildIssue({
          number: 188,
          title: 'Add profile routing observability budget warnings',
          body: createdByProposalIntakeBody,
          labels: ['agent:safe', 'agent:needs-plan'],
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/188',
        })],
        commentsByIssueNumber: { 188: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(0);
    });

    it('skips issues already resolved by proposal-intake reject-as-duplicate comments', () => {
      const duplicateDecisionComment = [
        '🤖 Agent note (proposal-intake)',
        '',
        'Resolution: reject-as-duplicate',
        'Reason: closed exact duplicate does not justify a fresh issue',
        'Target issue: #144',
        '',
        '<!-- AGENT-METADATA',
        'agent-id: proposal-intake',
        'agent-stage: proposal-intake',
        'resolution: reject-as-duplicate',
        'proposal-key: add-bounded-cache-invalidation-metrics-for-response-cache',
        'target-issue-number: 144',
        '-->',
      ].join('\n');

      const assignments = collectIssuerAssignments({
        issues: [buildIssue({ number: 189, url: 'https://github.com/davidruzicka/mcp4openapi/issues/189' })],
        commentsByIssueNumber: { 189: [buildComment(duplicateDecisionComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'issuer',
        runId: 'run-1',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(0);
    });
  });
});
