import { describe, expect, it } from 'vitest';
import {
  buildPlannerDecisionComment,
  collectPlannerAssignments,
  evaluatePlannerDecision,
  type PlannerIssue,
  type PlannerIssueComment,
} from './planner-runner.js';

function buildIssue(overrides: Partial<PlannerIssue> = {}): PlannerIssue {
  return {
    number: 160,
    title: 'Add deterministic cache invalidation metrics',
    body: [
      '## Summary',
      'Need targeted instrumentation for cache invalidation counts.',
      '',
      '## Acceptance Criteria',
      '- [ ] emit counter on invalidation',
      '- [ ] add unit tests for success and failure paths',
      '- [ ] document the metric',
    ].join('\n'),
    url: 'https://github.com/davidruzicka/mcp4openapi/issues/160',
    updatedAt: '2026-03-14T12:00:00Z',
    labels: ['agent:safe', 'agent:needs-plan'],
    ...overrides,
  };
}

function buildComment(body: string): PlannerIssueComment {
  return {
    id: 1,
    body,
    createdAt: '2026-03-14T12:00:00Z',
    updatedAt: '2026-03-14T12:00:00Z',
    authorLogin: 'github-actions[bot]',
  };
}

describe('planner-runner', () => {
  describe('evaluatePlannerDecision', () => {
    it('produces a concrete bounded plan for suitable issues', () => {
      const decision = evaluatePlannerDecision(buildIssue());

      expect(decision.remainsSuitable).toBe(true);
      expect(decision.plan).toContain('## Implementation plan');
      expect(decision.plan).toContain('Validation');
      expect(decision.reasons).toContain('issue body provides enough structure for a bounded implementation plan');
    });

    it('de-scopes unsuitable issues and can request a blocked lane', () => {
      const decision = evaluatePlannerDecision(buildIssue({
        title: 'Define security migration strategy',
        body: 'Need a broad auth and migration design before implementation.',
      }));

      expect(decision.remainsSuitable).toBe(false);
      expect(decision.blocked).toBe(true);
      expect(decision.plan).toBeUndefined();
      expect(decision.reasons).toContain('issue still matches high-risk keywords after deeper planning review');
    });
  });

  describe('collectPlannerAssignments', () => {
    it('queues needs-plan issues and returns planned transition labels', () => {
      const assignments = collectPlannerAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: { 160: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        issueNumber: 160,
        remainsSuitable: true,
        labelsToAdd: ['agent:planned', 'agent:safe'],
      });
      expect(assignments[0]?.commentBody).toContain('🤖 Agent plan (planner)');
      expect(assignments[0]?.commentBody).toContain('status: planned');
    });

    it('deduplicates equivalent planner decisions', () => {
      const commentBody = buildPlannerDecisionComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 160,
        agentId: 'planner',
        runId: 'run-2',
        timestamp: '2026-03-14T12:00:00Z',
        remainsSuitable: true,
        blocked: false,
        reasons: ['issue body provides enough structure for a bounded implementation plan'],
        plan: '## Implementation plan\n- Step 1',
      });

      const assignments = collectPlannerAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: { 160: [buildComment(commentBody)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(0);
    });

    it('skips issues outside the planner queue or already protected by hold labels', () => {
      expect(collectPlannerAssignments({
        issues: [
          buildIssue({ number: 161, labels: ['agent:safe'] }),
          buildIssue({ number: 162, labels: ['agent:safe', 'agent:needs-plan', 'human:hold'] }),
          buildIssue({ number: 163, labels: ['agent:safe', 'agent:needs-plan', 'agent:implementing'] }),
        ],
        commentsByIssueNumber: { 161: [], 162: [], 163: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      })).toEqual([]);
    });
  });
});
