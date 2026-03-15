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

  it('deduplicates equivalent proposal-intake comments by proposal key and resolution', () => {
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

  it('caps side effects per run even when multiple safe proposal actions exist', () => {
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
