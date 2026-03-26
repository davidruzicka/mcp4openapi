import { describe, expect, it } from 'vitest';
import {
  buildProposalResolutionComment,
  buildProposalTargetLinkComment,
  collectProposalAssignments,
  type ProposalContext,
  type ProposalIssueComment,
} from './proposal-intake-runner.js';

function buildProposal(overrides: Partial<ProposalContext> = {}): ProposalContext {
  return {
    proposalTitle: 'Add bounded cache invalidation metrics for response cache',
    proposalBody: 'Need narrow metrics and tests for cache invalidation counts.',
    proposalUrl: 'https://example.com/proposals/cache-metrics',
    issueNumber: 155,
    matches: [
      {
        number: 155,
        kind: 'issue',
        state: 'open',
        workflowState: 'candidate',
        relation: 'exact-duplicate',
        title: 'Add bounded cache invalidation metrics for response cache',
        url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
      },
    ],
    ...overrides,
  };
}

function buildComment(body: string): ProposalIssueComment {
  return {
    id: 1,
    body,
    createdAt: '2026-03-15T10:00:00Z',
    updatedAt: '2026-03-15T10:00:00Z',
    authorLogin: 'github-actions[bot]',
  };
}

function buildProposalIntakeCreatedIssueBody(input: {
  readonly summary: string;
  readonly sourceIssueNumber: number;
  readonly proposalKey: string;
  readonly sourceUrl?: string;
}): string {
  return [
    input.summary,
    '',
    `Source proposal: #${input.sourceIssueNumber}`,
    ...(input.sourceUrl ? [`Source URL: ${input.sourceUrl}`] : []),
    '',
    '<!-- AGENT-METADATA',
    'agent-stage: proposal-intake',
    'agent-role: created-issue',
    `source-issue-number: ${input.sourceIssueNumber}`,
    `proposal-key: ${input.proposalKey}`,
    '-->',
  ].join('\n');
}

describe('proposal-intake-runner', () => {
  it('queues one bounded proposal action with a metadata-backed agent note', () => {
    const assignments = collectProposalAssignments({
      proposals: [buildProposal()],
      commentsByIssueNumber: { 155: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      issueNumber: 155,
      action: 'comment-existing',
      targetIssueNumber: 155,
      proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
    });
    expect(assignments[0]?.commentBody).toContain('🤖 Agent note (proposal-intake)');
    expect(assignments[0]?.commentBody).toContain('agent-stage: proposal-intake');
    expect(assignments[0]?.commentBody).toContain('resolution: comment-existing');
  });

  it('returns no assignments when the worktree is dirty and proposal-intake should early-exit', () => {
    const assignments = collectProposalAssignments({
      proposals: [buildProposal()],
      commentsByIssueNumber: { 155: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
      worktreeDirty: true,
    });

    expect(assignments).toHaveLength(0);
  });

  it('skips issues already created by proposal-intake when they reappear as proposal sources', () => {
    const assignments = collectProposalAssignments({
      proposals: [buildProposal({
        issueNumber: 186,
        proposalTitle: 'Track bounded cache invalidation metrics rollout',
        proposalBody: buildProposalIntakeCreatedIssueBody({
          summary: 'Need narrow metrics and tests for cache invalidation counts.',
          sourceIssueNumber: 181,
          proposalKey: 'track-bounded-cache-invalidation-metrics-rollout',
          sourceUrl: 'https://github.com/davidruzicka/mcp4openapi/issues/181',
        }),
        matches: [],
      })],
      commentsByIssueNumber: { 186: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toEqual([]);
  });

  it('deduplicates proposal-intake comments by proposal key regardless of resolution action', () => {
    const commentBody = buildProposalResolutionComment({
      repository: 'davidruzicka/mcp4openapi',
      issueNumber: 155,
      agentId: 'proposal-intake',
      runId: 'run-3',
      timestamp: '2026-03-15T10:00:00Z',
      action: 'comment-existing',
      proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
      reason: 'open pre-implementation issue already tracks the same work',
      targetIssueNumber: 155,
    });

    const assignments = collectProposalAssignments({
      proposals: [buildProposal()],
      commentsByIssueNumber: { 155: [buildComment(commentBody)] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toHaveLength(0);
  });

  it('does not create a duplicate when a previously comment-existing proposal matches a now-closed issue', () => {
    // Regression: proposal was resolved as comment-existing (matched open issue #173).
    // Issue #173 later closed. Without the fix, re-evaluation with closed + regression
    // relation produces create-and-link (would create a duplicate issue), bypassing the
    // idempotency check because the action changed from comment-existing to create-and-link.
    const priorResolutionComment = buildProposalResolutionComment({
      repository: 'davidruzicka/mcp4openapi',
      issueNumber: 222,
      agentId: 'proposal-intake',
      runId: 'run-1',
      timestamp: '2026-03-24T10:00:00Z',
      action: 'comment-existing',
      proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
      reason: 'open pre-implementation issue already tracks the same work',
      targetIssueNumber: 173,
    });

    const assignments = collectProposalAssignments({
      proposals: [buildProposal({
        issueNumber: 222,
        matches: [
          {
            number: 173,
            kind: 'issue',
            state: 'closed',
            workflowState: 'unknown',
            // closed + regression → create-and-link (would create a duplicate issue)
            relation: 'regression',
            title: 'Add bounded cache invalidation metrics for response cache',
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/173',
          },
        ],
      })],
      commentsByIssueNumber: { 222: [buildComment(priorResolutionComment)] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-2',
      now: '2026-03-25T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toHaveLength(0);
  });

  it('builds a fresh issue creation payload for unmatched proposals', () => {
    const assignments = collectProposalAssignments({
      proposals: [buildProposal({
        issueNumber: 166,
        proposalTitle: 'Add profile routing observability budget warnings',
        proposalBody: 'Need a bounded warning threshold metric and focused tests.',
        proposalUrl: 'https://example.com/proposals/profile-routing-warnings',
        matches: [],
      })],
      commentsByIssueNumber: { 166: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      issueNumber: 166,
      action: 'create-fresh',
      createdIssueTitle: 'Add profile routing observability budget warnings',
      createdIssueBody: expect.stringContaining('Source proposal: #166'),
      createdIssueLabels: ['agent:safe', 'agent:needs-plan'],
      commentBody: expect.stringContaining('resolution: create-fresh'),
    });
    expect(assignments[0]?.createdIssueBody).toContain('Need a bounded warning threshold metric and focused tests.');
  });

  it('builds linked creation payloads for active matches and emits a target backlink note', () => {
    const assignments = collectProposalAssignments({
      proposals: [buildProposal({
        issueNumber: 177,
        matches: [{
          number: 155,
          kind: 'issue',
          state: 'open',
          workflowState: 'planned',
          relation: 'near-duplicate',
          title: 'Add bounded cache invalidation metrics for response cache',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
        }],
      })],
      commentsByIssueNumber: { 177: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      issueNumber: 177,
      action: 'create-and-link',
      targetIssueNumber: 155,
      createdIssueTitle: 'Add bounded cache invalidation metrics for response cache',
      createdIssueLabels: ['agent:safe', 'agent:needs-plan'],
      targetCommentBody: expect.stringContaining('Linked follow-up created from proposal #177'),
    });
    expect(assignments[0]?.targetCommentBody).toContain('agent-stage: proposal-intake');
  });

  it('persists reject-as-duplicate decisions as metadata-backed comments so downstream workflows can skip them', () => {
    const assignments = collectProposalAssignments({
      proposals: [buildProposal({
        issueNumber: 188,
        matches: [{
          number: 144,
          kind: 'issue',
          state: 'closed',
          workflowState: 'blocked',
          relation: 'exact-duplicate',
          title: 'Add bounded cache invalidation metrics for response cache',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/144',
        }],
      })],
      commentsByIssueNumber: { 188: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      issueNumber: 188,
      action: 'reject-as-duplicate',
      targetIssueNumber: 144,
      proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
      commentBody: expect.stringContaining('resolution: reject-as-duplicate'),
    });
    expect(assignments[0]?.commentBody).toContain('Target issue: #144');
  });

  it('keeps the side-effect budget at one action per run even when multiple bounded proposals are available', () => {
    const assignments = collectProposalAssignments({
      proposals: [
        buildProposal(),
        buildProposal({
          issueNumber: 166,
          proposalTitle: 'Add profile routing observability budget warnings',
          matches: [],
        }),
      ],
      commentsByIssueNumber: { 155: [], 166: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toHaveLength(1);
  });

  it('skips competing matches until a human resolves the ambiguity', () => {
    const assignments = collectProposalAssignments({
      proposals: [buildProposal({
        issueNumber: 190,
        matches: [
          {
            number: 155,
            kind: 'issue',
            state: 'open',
            workflowState: 'candidate',
            relation: 'exact-duplicate',
            title: 'Add bounded cache invalidation metrics for response cache',
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
          },
          {
            number: 191,
            kind: 'issue',
            state: 'open',
            workflowState: 'planned',
            relation: 'near-duplicate',
            title: 'Track cache invalidation budget warnings',
            url: 'https://github.com/davidruzicka/mcp4openapi/issues/191',
          },
        ],
      })],
      commentsByIssueNumber: { 190: [] },
      repository: 'davidruzicka/mcp4openapi',
      agentId: 'proposal-intake',
      runId: 'run-3',
      now: '2026-03-15T10:00:00Z',
      maxActions: 1,
    });

    expect(assignments).toEqual([]);
  });

  it('omits linked issue references when proposal comments do not have linked issue metadata yet', () => {
    const commentBody = buildProposalResolutionComment({
      repository: 'davidruzicka/mcp4openapi',
      issueNumber: 155,
      agentId: 'proposal-intake',
      runId: 'run-3',
      timestamp: '2026-03-15T10:00:00Z',
      action: 'create-and-link',
      proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
      reason: 'existing open work is already active, so a fresh linked follow-up is safer',
      targetIssueNumber: 155,
    });

    expect(commentBody).not.toContain('Linked issue: #');
  });

  it('deduplicates equivalent target backlink comments by proposal key and source issue', () => {
    const commentBody = buildProposalTargetLinkComment({
      repository: 'davidruzicka/mcp4openapi',
      sourceIssueNumber: 177,
      targetIssueNumber: 155,
      linkedIssueNumber: 188,
      linkedIssueUrl: 'https://github.com/davidruzicka/mcp4openapi/issues/188',
      agentId: 'proposal-intake',
      runId: 'run-3',
      timestamp: '2026-03-15T10:00:00Z',
      proposalKey: 'add-bounded-cache-invalidation-metrics-for-response-cache',
      reason: 'existing open work is already active, so a fresh linked follow-up is safer',
    });

    expect(commentBody).toContain('Linked follow-up created from proposal #177');
    expect(commentBody).toContain('linked-issue-number: 188');
    expect(commentBody).toContain('target-issue-number: 155');
  });
});
