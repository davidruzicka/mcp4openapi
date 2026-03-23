import { describe, expect, it } from 'vitest';
import {
  buildImplementorLeaseComment,
  buildImplementorResultComment,
  buildImplementorReviewThreadReplyPlans,
  collectImplementorAssignments,
  parseImplementorCommandResult,
  parseImplementorTaskPayload,
  planImplementorResultLabels,
  selectLatestTrustedPlannerArtifact,
  type ImplementorIssue,
  type ImplementorIssueComment,
} from './implementor-runner.js';
import { serializePlannerArtifact } from './planner-artifact.js';

const strictTrustConfig = {
  allowUnsigned: false,
  signing: {
    key: 'signing-secret',
    keyId: 'primary',
  },
} as const;

const unsignedCompatibilityTrustConfig = {
  allowUnsigned: true,
} as const;

function buildPlannerArtifact() {
  return {
    kind: 'review-follow-up' as const,
    threadId: 'thread-1',
    sourceCommentId: 'comment-2',
    headSha: 'abc123',
    fixSummary: 'Cover the fallback path',
    implementationSteps: ['Update fallback handling.'],
    testSteps: ['Add a regression test for the fallback path.'],
    verificationSteps: ['Run targeted automation tests.'],
  };
}

function buildSignedPlannerArtifact(): string {
  return serializePlannerArtifact(buildPlannerArtifact(), {
    signing: strictTrustConfig.signing,
  });
}

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

    it('skips issues when an implementor lease is still active even without an open pull request', () => {
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
        now: '2026-03-14T12:15:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toEqual([]);
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

    it('ignores non-implementor metadata when evaluating active leases', () => {
      const assignments = collectImplementorAssignments({
        issues: [buildIssue()],
        commentsByIssueNumber: {
          161: [buildComment([
            '🤖 Agent note (reviewer)',
            '',
            '<!-- AGENT-METADATA',
            'agent-stage: reviewer',
            'status: approved',
            'timestamp: 2026-03-14T12:00:00Z',
            '-->',
          ].join('\n'))],
        },
        openPullRequestsByIssueNumber: {},
        repository: 'davidruzicka/mcp4openapi',
        agentId: 'implementor',
        runId: 'run-3',
        now: '2026-03-14T12:15:00Z',
        leaseTtlMinutes: 30,
      });

      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.issueNumber).toBe(161);
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

  describe('selectLatestTrustedPlannerArtifact', () => {
    it('prefers the newest trusted signed planner artifact over older unsigned comments in strict mode', () => {
      const newerArtifact = {
        ...buildPlannerArtifact(),
        sourceCommentId: 'comment-3',
        fixSummary: 'Handle the newest signed review follow-up',
      };
      const comments = [
        buildComment(serializePlannerArtifact(buildPlannerArtifact())),
        buildComment(serializePlannerArtifact(newerArtifact, {
          signing: strictTrustConfig.signing,
        })),
      ];

      expect(selectLatestTrustedPlannerArtifact(comments, strictTrustConfig)).toEqual(newerArtifact);
    });

    it('fails closed when the newest artifact-bearing comment is untrusted in strict mode', () => {
      const comments = [
        buildComment(buildSignedPlannerArtifact()),
        buildComment(serializePlannerArtifact({
          ...buildPlannerArtifact(),
          sourceCommentId: 'comment-4',
          fixSummary: 'Unsigned planner artifact should block strict mode',
        })),
      ];

      expect(() => selectLatestTrustedPlannerArtifact(comments, strictTrustConfig)).toThrow(
        'Invalid planner artifact: unsigned artifacts are not trusted.',
      );
    });

    it('returns undefined when no issue comments contain a planner artifact', () => {
      expect(selectLatestTrustedPlannerArtifact([
        buildComment('No planner artifact here.'),
      ], strictTrustConfig)).toBeUndefined();
    });
  });

  describe('parseImplementorTaskPayload', () => {
    it('rejects missing and incomplete workflow payloads', () => {
      expect(() => parseImplementorTaskPayload(undefined)).toThrow(
        'Missing IMPLEMENTOR_TASK_JSON payload for implementor workflow.',
      );

      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }))).toThrow('missing required workflow fields');
    });

    it('maps unknown planner artifact validation failures to the generic payload error', () => {
      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: [
          '<!-- AGENT-PLANNER-ARTIFACT',
          JSON.stringify({
            ...buildPlannerArtifact(),
            implementationSteps: [],
          }),
          '-->',
        ].join('\n'),
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: unsignedCompatibilityTrustConfig,
      })).toThrow('plannerArtifact must be a valid review-follow-up artifact');
    });

    it('parses trusted signed planner artifacts and review follow-up items from the implementor payload', () => {
      const payload = parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: buildSignedPlannerArtifact(),
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      });

      expect(payload.plannerArtifact).toMatchObject({ threadId: 'thread-1', sourceCommentId: 'comment-2', headSha: 'abc123' });
      expect(payload.reviewFollowUpItems).toHaveLength(1);
    });

    it('rejects unsigned planner artifacts when compatibility mode is disabled', () => {
      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: serializePlannerArtifact(buildPlannerArtifact()),
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toThrow('plannerArtifact must be signed or explicitly allowed unsigned');
    });

    it('accepts unsigned planner artifacts when compatibility mode is explicitly enabled', () => {
      const payload = parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: serializePlannerArtifact(buildPlannerArtifact()),
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: unsignedCompatibilityTrustConfig,
      });

      expect(payload.plannerArtifact).toMatchObject({ threadId: 'thread-1', sourceCommentId: 'comment-2', headSha: 'abc123' });
    });

    it('rejects tampered signed artifacts and missing signing keys on trusted paths', () => {
      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: buildSignedPlannerArtifact().replace('Cover the fallback path', 'Tampered summary'),
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toThrow('plannerArtifact signature verification failed');

      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: buildSignedPlannerArtifact(),
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: {
          allowUnsigned: false,
        },
      })).toThrow('plannerArtifact signing key is not configured');
    });

    it('fails closed for invalid planner artifacts in the payload', () => {
      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        plannerArtifact: '## Implementation plan',
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toThrow('plannerArtifact must be a valid review-follow-up artifact');
    });

    it('rejects malformed, non-object, and incomplete planner follow-up payloads', () => {
      expect(() => parseImplementorTaskPayload('not-json', {
        trustConfig: strictTrustConfig,
      })).toThrow('Invalid IMPLEMENTOR_TASK_JSON payload: expected JSON.');
      expect(() => parseImplementorTaskPayload('[]', {
        trustConfig: strictTrustConfig,
      })).toThrow('Invalid IMPLEMENTOR_TASK_JSON payload: expected object payload.');

      const signedArtifact = buildSignedPlannerArtifact();

      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        plannerArtifact: signedArtifact,
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toThrow('plannerArtifact requires reviewFollowUpItems');

      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: '',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: signedArtifact,
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toThrow('reviewFollowUpItems must include threadId, headSha, sourceCommentId, and summary');
    });
  });

  describe('buildImplementorReviewThreadReplyPlans', () => {
    it('builds thread reply plans for successful review follow-up results', () => {
      const replies = buildImplementorReviewThreadReplyPlans({
        task: parseImplementorTaskPayload(JSON.stringify({
          repository: 'davidruzicka/mcp4openapi',
          issue: {
            number: 161,
            title: 'Add cache invalidation metrics',
            body: 'Need bounded instrumentation and tests.',
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
          },
          reviewFollowUpItems: [{
            threadId: 'thread-1',
            headSha: 'abc123',
            sourceCommentId: 'comment-2',
            summary: 'Add a regression test for the fallback path',
            actionability: 'actionable',
            requiresReply: true,
          }],
          plannerArtifact: buildSignedPlannerArtifact(),
          runId: 'run-3',
          agentId: 'implementor',
          now: '2026-03-14T12:00:00Z',
        }), {
          trustConfig: strictTrustConfig,
        }),
        result: {
          outcome: 'pr-created',
          summary: 'Created PR #201 with targeted follow-up coverage.',
          pullRequest: {
            number: 201,
            url: 'https://github.com/davidruzicka/mcp4openapi/pull/201',
          },
        },
        newHeadSha: 'def456',
      });

      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        threadId: 'thread-1',
        inReplyToCommentId: 'comment-2',
        headSha: 'def456',
      });
      expect(replies[0]?.body).toContain('This reply was prepared by an agent.');
      expect(replies[0]?.body).toContain('def456');
      expect(replies[0]?.body).toContain('source-comment-id: comment-2');
    });

    it('fails closed when follow-up replies are not tied to a created PR head', () => {
      const task = parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: buildSignedPlannerArtifact(),
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      });

      expect(buildImplementorReviewThreadReplyPlans({
        task,
        result: {
          outcome: 'blocked',
          summary: 'Needs a human decision.',
        },
        newHeadSha: 'def456',
      })).toEqual([]);

      expect(buildImplementorReviewThreadReplyPlans({
        task,
        result: {
          outcome: 'pr-created',
          summary: 'Created PR #201 with targeted follow-up coverage.',
          pullRequest: {
            number: 201,
            url: 'https://github.com/davidruzicka/mcp4openapi/pull/201',
          },
        },
        newHeadSha: '',
      })).toEqual([]);
    });

    it('returns no review-thread reply plans without planner artifacts or follow-up items', () => {
      const task = parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 161,
          title: 'Add cache invalidation metrics',
          body: 'Need bounded instrumentation and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/161',
        },
        runId: 'run-3',
        agentId: 'implementor',
        now: '2026-03-14T12:00:00Z',
      }));

      expect(buildImplementorReviewThreadReplyPlans({
        task,
        result: {
          outcome: 'blocked',
          summary: 'Needs a human decision.',
        },
        newHeadSha: 'def456',
      })).toEqual([]);
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

    it('includes a review follow-up count when follow-up items are present', () => {
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
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
      });

      expect(comment).toContain('Review follow-up items: 1');
    });

    it('omits PR and review follow-up lines when optional fields are absent', () => {
      const comment = buildImplementorResultComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 161,
        agentId: 'implementor',
        runId: 'run-4',
        timestamp: '2026-03-14T12:40:00Z',
        result: {
          outcome: 'blocked',
          summary: 'Needs a human policy decision.',
        },
      });

      expect(comment).toContain('Implementation result: blocked');
      expect(comment).not.toContain('PR: #');
      expect(comment).not.toContain('Review follow-up items:');
      expect(comment).toContain('status: blocked');
    });

    it('omits the review follow-up line when the item list is empty', () => {
      const comment = buildImplementorResultComment({
        repository: 'davidruzicka/mcp4openapi',
        issueNumber: 161,
        agentId: 'implementor',
        runId: 'run-5',
        timestamp: '2026-03-14T12:45:00Z',
        result: {
          outcome: 'pr-created',
          summary: 'Created PR #202 with tests.',
          pullRequest: {
            number: 202,
            url: 'https://github.com/davidruzicka/mcp4openapi/pull/202',
          },
        },
        reviewFollowUpItems: [],
      });

      expect(comment).toContain('PR: #202');
      expect(comment).not.toContain('Review follow-up items:');
    });
  });
});
