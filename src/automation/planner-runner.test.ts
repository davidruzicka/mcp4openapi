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
        reasons: [
          'issue body provides enough structure for a bounded implementation plan',
          'issue remains inside the low-risk autonomous planning lane',
        ],
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

    it('de-scopes near-duplicate issues when semantic duplicate triage finds an earlier open match', () => {
      const assignments = collectPlannerAssignments({
        issues: [
          buildIssue(),
          buildIssue({
            number: 161,
            title: 'Add deterministic metrics for cache flush invalidation',
            body: [
              '## Summary',
              'Need targeted instrumentation for cache invalidation counts and flush paths.',
              '',
              '## Acceptance Criteria',
              '- [ ] emit counter on invalidation',
              '- [ ] add unit tests for flush and failure paths',
              '- [ ] document the metric',
            ].join('\n'),
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
          }),
        ],
        commentsByIssueNumber: { 160: [], 161: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        semanticDuplicateBackendName: 'local-heuristic-v1',
      });

      expect(assignments).toHaveLength(2);
      expect(assignments[1]).toMatchObject({
        issueNumber: 161,
        remainsSuitable: false,
        blocked: false,
        labelsToAdd: [],
        labelsToRemove: ['agent:safe', 'agent:needs-plan', 'agent:planned'],
      });
      expect(assignments[1]?.reasons).toContain('issue appears to semantically duplicate existing open issue #160');
      expect(assignments[1]?.commentBody).toContain('Semantic duplicate backend:');
      expect(assignments[1]?.commentBody).toContain('Duplicate guard minimum fallback: exact open-title matches remain enforced even if semantic triage is unavailable.');
    });

    it('keeps related issues in scope when semantic duplicate triage stays below the duplicate threshold', () => {
      const assignments = collectPlannerAssignments({
        issues: [
          buildIssue(),
          buildIssue({
            number: 162,
            title: 'Document cache invalidation rollout notes',
            body: [
              '## Summary',
              'Document the rollout and incident notes for cache invalidation metrics.',
              '',
              '## Acceptance Criteria',
              '- [ ] add rollout notes',
              '- [ ] explain operator expectations',
            ].join('\n'),
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/162',
          }),
        ],
        commentsByIssueNumber: { 160: [], 162: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        semanticDuplicateBackendName: 'local-heuristic-v1',
      });

      expect(assignments).toHaveLength(2);
      expect(assignments[1]).toMatchObject({
        issueNumber: 162,
        remainsSuitable: true,
        blocked: false,
        labelsToAdd: ['agent:planned', 'agent:safe'],
      });
      expect(assignments[1]?.reasons).not.toContain('issue appears to semantically duplicate existing open issue #160');
    });

    it('supports disabling semantic duplicate triage while preserving exact-title fallback only', () => {
      const assignments = collectPlannerAssignments({
        issues: [
          buildIssue(),
          buildIssue({
            number: 161,
            title: 'Add deterministic metrics for cache flush invalidation',
            body: [
              '## Summary',
              'Need targeted instrumentation for cache invalidation counts and flush paths.',
              '',
              '## Acceptance Criteria',
              '- [ ] emit counter on invalidation',
              '- [ ] add unit tests for flush and failure paths',
              '- [ ] document the metric',
            ].join('\n'),
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
          }),
        ],
        commentsByIssueNumber: { 160: [], 161: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        semanticDuplicateBackendName: 'disabled',
      });

      expect(assignments).toHaveLength(2);
      expect(assignments[1]).toMatchObject({
        issueNumber: 161,
        remainsSuitable: true,
        blocked: false,
        labelsToAdd: ['agent:planned', 'agent:safe'],
      });
    });

    it('keeps high-risk duplicate issues blocked instead of downgrading them to de-scoped', () => {
      const assignments = collectPlannerAssignments({
        issues: [
          buildIssue({
            title: 'Add deterministic cache invalidation metrics for auth token refresh',
            body: [
              '## Summary',
              'Need targeted instrumentation for cache invalidation counts during auth token refresh.',
              '',
              '## Acceptance Criteria',
              '- [ ] emit counter on invalidation',
              '- [ ] add unit tests for success and failure paths',
              '- [ ] document the metric',
            ].join('\n'),
          }),
          buildIssue({
            number: 161,
            title: 'Add deterministic metrics for auth token refresh invalidation',
            body: [
              '## Summary',
              'Need targeted instrumentation for cache invalidation counts during auth token refresh.',
              '',
              '## Acceptance Criteria',
              '- [ ] emit counter on invalidation',
              '- [ ] add unit tests for token refresh failure paths',
              '- [ ] document the metric',
            ].join('\n'),
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
          }),
        ],
        commentsByIssueNumber: { 160: [], 161: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        semanticDuplicateBackendName: 'local-heuristic-v1',
      });

      expect(assignments).toHaveLength(2);
      expect(assignments[1]).toMatchObject({
        issueNumber: 161,
        remainsSuitable: false,
        blocked: true,
        labelsToAdd: ['agent:blocked'],
      });
      expect(assignments[1]?.reasons).toContain('issue appears to semantically duplicate existing open issue #160');
    });

    it('does not suppress a duplicate-specific de-scoped comment when an older de-scoped comment had different reasons', () => {
      const previousDescopedComment = buildPlannerDecisionComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 161,
        agentId: 'planner',
        runId: 'run-old',
        timestamp: '2026-03-14T11:00:00Z',
        remainsSuitable: false,
        blocked: false,
        reasons: ['issue body is still too vague for bounded implementation'],
      });

      const assignments = collectPlannerAssignments({
        issues: [
          buildIssue(),
          buildIssue({
            number: 161,
            title: 'Add deterministic metrics for cache flush invalidation',
            body: [
              '## Summary',
              'Need targeted instrumentation for cache invalidation counts and flush paths.',
              '',
              '## Acceptance Criteria',
              '- [ ] emit counter on invalidation',
              '- [ ] add unit tests for flush and failure paths',
              '- [ ] document the metric',
            ].join('\n'),
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
          }),
        ],
        commentsByIssueNumber: { 160: [], 161: [buildComment(previousDescopedComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        semanticDuplicateBackendName: 'local-heuristic-v1',
      });

      expect(assignments).toHaveLength(2);
      const duplicateAssignment = assignments.find((assignment) => assignment.issueNumber === 161);
      expect(duplicateAssignment?.issueNumber).toBe(161);
      expect(duplicateAssignment?.reasons).toContain('issue appears to semantically duplicate existing open issue #160');
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
