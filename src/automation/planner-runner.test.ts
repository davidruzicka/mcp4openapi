import { describe, expect, it } from 'vitest';
import { parsePlannerArtifact } from './planner-artifact.js';
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

    it('emits a serialized planner artifact for review-follow-up issue context', () => {
      const decision = evaluatePlannerDecision(buildIssue({
        body: [
          'Review thread: thread-1',
          'Source comment ID: comment-1',
          'Head SHA: abc123',
          'Fix summary: Cover the fallback path',
          'Implementation steps:',
          '- Update fallback handling.',
          'Test steps:',
          '- Add a regression test for the fallback path.',
          'Verification steps:',
          '- Run targeted automation tests.',
        ].join('\n'),
      }));

      expect(decision.remainsSuitable).toBe(true);
      expect(decision.plan).toContain('## Review follow-up implementation plan');
      expect(decision.plannerArtifact).toMatchObject({
        kind: 'review-follow-up',
        threadId: 'thread-1',
        sourceCommentId: 'comment-1',
        headSha: 'abc123',
      });
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

    it('emits blocked planner status when a high-risk issue is de-scoped from autonomous planning', () => {
      const assignments = collectPlannerAssignments({
        issues: [buildIssue({
          title: 'Define security migration strategy',
          body: 'Need a broad auth and migration design before implementation.',
        })],
        commentsByIssueNumber: { 160: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.commentBody).toContain('Planner decision: blocked');
      expect(assignments[0]?.commentBody).toContain('status: blocked');
    });

    it('includes a signed planner artifact in the planner comment when signing is configured', () => {
      const plannerArtifact = {
        kind: 'review-follow-up' as const,
        threadId: 'thread-1',
        sourceCommentId: 'comment-1',
        headSha: 'abc123',
        fixSummary: 'Cover the fallback path',
        implementationSteps: ['Update fallback handling.'],
        testSteps: ['Add a regression test for the fallback path.'],
        verificationSteps: ['Run targeted automation tests.'],
      };

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
        plan: '## Review follow-up implementation plan\n- Step 1',
        plannerArtifact,
        artifactSigning: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      });

      expect(commentBody).toContain('"algorithm":"hmac-sha256"');
      expect(commentBody).toContain('"signature":');
      expect(parsePlannerArtifact(commentBody)).toEqual(plannerArtifact);
    });

    it('does not emit an artifact block when there is no planner artifact to serialize', () => {
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
        artifactSigning: {
          key: 'signing-secret',
          keyId: 'primary',
        },
      });

      expect(commentBody).not.toContain('AGENT-PLANNER-ARTIFACT');
    });

    it('deduplicates equivalent planner decisions when artifact object keys appear in a different order', () => {
      const reorderedArtifactComment = [
        '🤖 Agent plan (planner)',
        '',
        'Planner decision: planned',
        'Reasons:',
        '- issue body provides enough structure for a bounded implementation plan',
        '- issue remains inside the low-risk autonomous planning lane',
        '',
        '<!-- AGENT-PLANNER-ARTIFACT',
        JSON.stringify({
          fixSummary: 'Cover the fallback path',
          verificationSteps: ['Run targeted automation tests.'],
          kind: 'review-follow-up',
          testSteps: ['Add a regression test for the fallback path.'],
          headSha: 'abc123',
          implementationSteps: ['Update fallback handling.'],
          sourceCommentId: 'comment-1',
          threadId: 'thread-1',
        }),
        '-->',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: planner',
        'status: planned',
        'reasons: issue body provides enough structure for a bounded implementation plan,issue remains inside the low-risk autonomous planning lane',
        '-->',
      ].join('\n');

      const assignments = collectPlannerAssignments({
        issues: [buildIssue({
          body: [
            'Review thread: thread-1',
            'Source comment ID: comment-1',
            'Head SHA: abc123',
            'Fix summary: Cover the fallback path',
            'Implementation steps:',
            '- Update fallback handling.',
            'Test steps:',
            '- Add a regression test for the fallback path.',
            'Verification steps:',
            '- Run targeted automation tests.',
          ].join('\n'),
        })],
        commentsByIssueNumber: { 160: [buildComment(reorderedArtifactComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(0);
    });

    it('deduplicates equivalent planner decisions without planner artifacts', () => {
      const existingComment = buildPlannerDecisionComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 160,
        agentId: 'planner',
        runId: 'run-1',
        timestamp: '2026-03-14T11:00:00Z',
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
        commentsByIssueNumber: { 160: [buildComment(existingComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(0);
    });

    it('does not deduplicate planner comments when metadata no longer matches the current decision', () => {
      const mismatchedMetadataComment = [
        '🤖 Agent plan (planner)',
        '',
        'Planner decision: planned',
        'Reasons:',
        '- issue body provides enough structure for a bounded implementation plan',
        '- issue remains inside the low-risk autonomous planning lane',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: planner',
        'status: blocked',
        'reasons: issue body provides enough structure for a bounded implementation plan,issue remains inside the low-risk autonomous planning lane',
        '-->',
      ].join('\n');

      const assignments = collectPlannerAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: { 160: [buildComment(mismatchedMetadataComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.commentBody).toContain('Planner decision: planned');
    });

    it('still deduplicates against equivalent unsigned legacy planner artifacts when signed output is required', () => {
      const plannerArtifact = {
        kind: 'review-follow-up' as const,
        threadId: 'thread-1',
        sourceCommentId: 'comment-1',
        headSha: 'abc123',
        fixSummary: 'Cover the fallback path',
        implementationSteps: ['Update fallback handling.'],
        testSteps: ['Add a regression test for the fallback path.'],
        verificationSteps: ['Run targeted automation tests.'],
      };
      const unsignedCommentBody = buildPlannerDecisionComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 160,
        agentId: 'planner',
        runId: 'run-1',
        timestamp: '2026-03-14T11:00:00Z',
        remainsSuitable: true,
        blocked: false,
        reasons: [
          'issue body provides enough structure for a bounded implementation plan',
          'issue remains inside the low-risk autonomous planning lane',
        ],
        plan: '## Implementation plan\n- Step 1',
        plannerArtifact,
      });

      const assignments = collectPlannerAssignments({
        issues: [buildIssue({
          body: [
            'Review thread: thread-1',
            'Source comment ID: comment-1',
            'Head SHA: abc123',
            'Fix summary: Cover the fallback path',
            'Implementation steps:',
            '- Update fallback handling.',
            'Test steps:',
            '- Add a regression test for the fallback path.',
            'Verification steps:',
            '- Run targeted automation tests.',
          ].join('\n'),
        })],
        commentsByIssueNumber: { 160: [buildComment(unsignedCommentBody)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        artifactSigning: {
          key: 'new-signing-secret',
          keyId: 'new',
        },
      });

      expect(assignments).toHaveLength(0);
    });

    it('does not treat malformed signed envelopes as equivalent when signed output is required', () => {
      const malformedSignedComment = [
        '🤖 Agent plan (planner)',
        '',
        'Planner decision: planned',
        'Reasons:',
        '- issue body provides enough structure for a bounded implementation plan',
        '- issue remains inside the low-risk autonomous planning lane',
        '',
        '<!-- AGENT-PLANNER-ARTIFACT',
        JSON.stringify({
          version: 2,
          kind: 'review-follow-up',
          algorithm: 'hmac-sha256',
          keyId: 'primary',
          payload: {
            kind: 'review-follow-up',
            threadId: 'thread-1',
            sourceCommentId: 'comment-1',
            headSha: 'abc123',
            fixSummary: 'Cover the fallback path',
            implementationSteps: ['Update fallback handling.'],
            testSteps: ['Add a regression test for the fallback path.'],
            verificationSteps: ['Run targeted automation tests.'],
          },
          signature: 'abc123',
        }),
        '-->',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: planner',
        'status: planned',
        'reasons: issue body provides enough structure for a bounded implementation plan,issue remains inside the low-risk autonomous planning lane',
        '-->',
      ].join('\n');

      const assignments = collectPlannerAssignments({
        issues: [buildIssue({
          body: [
            'Review thread: thread-1',
            'Source comment ID: comment-1',
            'Head SHA: abc123',
            'Fix summary: Cover the fallback path',
            'Implementation steps:',
            '- Update fallback handling.',
            'Test steps:',
            '- Add a regression test for the fallback path.',
            'Verification steps:',
            '- Run targeted automation tests.',
          ].join('\n'),
        })],
        commentsByIssueNumber: { 160: [buildComment(malformedSignedComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        artifactSigning: {
          key: 'new-signing-secret',
          keyId: 'new',
        },
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.commentBody).toContain('"signature":');
    });

    it('does not treat tampered signed artifacts as equivalent when signed output is required', () => {
      const signedComment = buildPlannerDecisionComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 160,
        agentId: 'planner',
        runId: 'run-1',
        timestamp: '2026-03-14T12:00:00Z',
        remainsSuitable: true,
        blocked: false,
        reasons: [
          'issue body provides enough structure for a bounded implementation plan',
          'issue remains inside the low-risk autonomous planning lane',
        ],
        plan: '## Review follow-up implementation plan',
        plannerArtifact: {
          kind: 'review-follow-up',
          threadId: 'thread-1',
          sourceCommentId: 'comment-1',
          headSha: 'abc123',
          fixSummary: 'Cover the fallback path',
          implementationSteps: ['Update fallback handling.'],
          testSteps: ['Add a regression test for the fallback path.'],
          verificationSteps: ['Run targeted automation tests.'],
        },
        artifactSigning: {
          key: 'new-signing-secret',
          keyId: 'new',
        },
      }).replace('Cover the fallback path', 'Tampered summary');

      const assignments = collectPlannerAssignments({
        issues: [buildIssue({
          body: [
            'Review thread: thread-1',
            'Source comment ID: comment-1',
            'Head SHA: abc123',
            'Fix summary: Cover the fallback path',
            'Implementation steps:',
            '- Update fallback handling.',
            'Test steps:',
            '- Add a regression test for the fallback path.',
            'Verification steps:',
            '- Run targeted automation tests.',
          ].join('\n'),
        })],
        commentsByIssueNumber: { 160: [buildComment(signedComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        artifactSigning: {
          key: 'new-signing-secret',
          keyId: 'new',
        },
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.commentBody).toContain('"signature":');
    });

    it('does not deduplicate unsigned planner output against unverified signed envelopes when signing is disabled', () => {
      const signedComment = buildPlannerDecisionComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 160,
        agentId: 'planner',
        runId: 'run-1',
        timestamp: '2026-03-14T12:00:00Z',
        remainsSuitable: true,
        blocked: false,
        reasons: [
          'issue body provides enough structure for a bounded implementation plan',
          'issue remains inside the low-risk autonomous planning lane',
        ],
        plan: '## Review follow-up implementation plan',
        plannerArtifact: {
          kind: 'review-follow-up',
          threadId: 'thread-1',
          sourceCommentId: 'comment-1',
          headSha: 'abc123',
          fixSummary: 'Cover the fallback path',
          implementationSteps: ['Update fallback handling.'],
          testSteps: ['Add a regression test for the fallback path.'],
          verificationSteps: ['Run targeted automation tests.'],
        },
        artifactSigning: {
          key: 'new-signing-secret',
          keyId: 'new',
        },
      });

      const assignments = collectPlannerAssignments({
        issues: [buildIssue({
          body: [
            'Review thread: thread-1',
            'Source comment ID: comment-1',
            'Head SHA: abc123',
            'Fix summary: Cover the fallback path',
            'Implementation steps:',
            '- Update fallback handling.',
            'Test steps:',
            '- Add a regression test for the fallback path.',
            'Verification steps:',
            '- Run targeted automation tests.',
          ].join('\n'),
        })],
        commentsByIssueNumber: { 160: [buildComment(signedComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.commentBody).not.toContain('"signature":');
    });

    it('ignores malformed planner artifacts when deduplicating decision comments', () => {
      const malformedComment = [
        '🤖 Agent plan (planner)',
        '',
        'Planner decision: planned',
        'Reasons:',
        '- issue body provides enough structure for a bounded implementation plan',
        '- issue remains inside the low-risk autonomous planning lane',
        '',
        '<!-- AGENT-PLANNER-ARTIFACT',
        '{not-json}',
        '-->',
        '',
        '<!-- AGENT-METADATA',
        'agent-stage: planner',
        'status: planned',
        'reasons: issue body provides enough structure for a bounded implementation plan,issue remains inside the low-risk autonomous planning lane',
        '-->',
      ].join('\n');

      const assignments = collectPlannerAssignments({
        issues: [buildIssue({
          body: [
            'Review thread: thread-1',
            'Source comment ID: comment-1',
            'Head SHA: abc123',
            'Fix summary: Cover the fallback path',
            'Implementation steps:',
            '- Update fallback handling.',
            'Test steps:',
            '- Add a regression test for the fallback path.',
            'Verification steps:',
            '- Run targeted automation tests.',
          ].join('\n'),
        })],
        commentsByIssueNumber: { 160: [buildComment(malformedComment)] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.commentBody).toContain('comment-1');
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

    it('ignores held or blocked older issues when building duplicate candidates for the planner lane', () => {
      const assignments = collectPlannerAssignments({
        issues: [
          buildIssue({
            number: 158,
            title: 'Add deterministic cache invalidation metrics',
            labels: ['agent:safe', 'agent:needs-plan', 'human:hold'],
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/158',
          }),
          buildIssue({
            number: 159,
            title: 'Add deterministic cache invalidation metrics for blocked lane',
            labels: ['agent:safe', 'agent:needs-plan', 'agent:blocked'],
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/159',
          }),
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
        commentsByIssueNumber: { 158: [], 159: [], 161: [] },
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'planner',
        runId: 'run-2',
        now: '2026-03-14T12:00:00Z',
        semanticDuplicateBackendName: 'local-heuristic-v1',
      });

      expect(assignments).toHaveLength(1);
      const assignment = assignments.find((entry) => entry.issueNumber === 161);
      expect(assignment).toMatchObject({
        issueNumber: 161,
        remainsSuitable: true,
        blocked: false,
        labelsToAdd: ['agent:planned', 'agent:safe'],
      });
      expect(assignment?.reasons).not.toContain('issue appears to semantically duplicate existing open issue #158');
      expect(assignment?.reasons).not.toContain('issue appears to semantically duplicate existing open issue #159');
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
      expect(assignments[1]?.commentBody).not.toContain('Semantic duplicate backend:');
    });
  });
});
