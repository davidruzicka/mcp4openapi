import { isProposalIntakeCreatedIssue } from './agent-metadata-guards.js';
import { buildAgentMetadataBlock } from './agent-feedback.js';
import { parseAgentMetadata } from './evaluator-runner.js';
import {
  buildProposalKey,
  planProposalResolution,
  type ProposalCandidateMatch,
  type ProposalResolutionAction,
} from './proposal-intake.js';

export interface ProposalContext {
  readonly proposalTitle: string;
  readonly proposalBody: string;
  readonly proposalUrl: string;
  readonly issueNumber: number;
  readonly matches: readonly ProposalCandidateMatch[];
}

export interface ProposalIssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface ProposalAssignment {
  readonly issueNumber: number;
  readonly action: ProposalResolutionAction;
  readonly proposalKey: string;
  readonly reason: string;
  readonly targetIssueNumber?: number;
  readonly commentBody: string;
  readonly createdIssueTitle?: string;
  readonly createdIssueBody?: string;
  readonly createdIssueLabels?: readonly string[];
  readonly targetCommentBody?: string;
}

export interface CollectProposalAssignmentsInput {
  readonly proposals: readonly ProposalContext[];
  readonly commentsByIssueNumber: Readonly<Record<number, readonly ProposalIssueComment[]>>;
  readonly repository: string;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
  readonly maxActions: number;
  readonly worktreeDirty?: boolean;
}

export function collectProposalAssignments(input: CollectProposalAssignmentsInput): ProposalAssignment[] {
  if (input.worktreeDirty) {
    return [];
  }

  const assignments: ProposalAssignment[] = [];
  for (const proposal of input.proposals) {
    if (assignments.length >= input.maxActions) {
      break;
    }

    if (isProposalIntakeCreatedIssue(proposal.proposalBody)) {
      continue;
    }

    const resolution = planProposalResolution({
      proposalTitle: proposal.proposalTitle,
      matches: proposal.matches,
    });
    if (resolution.action === 'no-action') {
      continue;
    }

    if (hasEquivalentProposalComment(input.commentsByIssueNumber[proposal.issueNumber] ?? [], resolution.action, resolution.proposalKey)) {
      continue;
    }

    assignments.push({
      issueNumber: proposal.issueNumber,
      action: resolution.action,
      proposalKey: resolution.proposalKey,
      reason: resolution.reason,
      targetIssueNumber: resolution.targetIssueNumber,
      commentBody: buildProposalResolutionComment({
        repository: input.repository,
        issueNumber: proposal.issueNumber,
        agentId: input.agentId,
        runId: input.runId,
        timestamp: input.now,
        action: resolution.action,
        proposalKey: resolution.proposalKey,
        reason: resolution.reason,
        targetIssueNumber: resolution.targetIssueNumber,
      }),
      ...(resolution.action === 'create-fresh' || resolution.action === 'create-and-link'
        ? {
            createdIssueTitle: proposal.proposalTitle,
            createdIssueBody: buildProposalCreatedIssueBody({
              proposalTitle: proposal.proposalTitle,
              proposalBody: proposal.proposalBody,
              proposalUrl: proposal.proposalUrl,
              sourceIssueNumber: proposal.issueNumber,
              targetIssueNumber: resolution.targetIssueNumber,
            }),
            createdIssueLabels: ['agent:safe', 'agent:needs-plan'],
          }
        : {}),
      ...(resolution.action === 'create-and-link' && resolution.targetIssueNumber
        ? {
            targetCommentBody: buildProposalTargetLinkComment({
              repository: input.repository,
              sourceIssueNumber: proposal.issueNumber,
              targetIssueNumber: resolution.targetIssueNumber,
              agentId: input.agentId,
              runId: input.runId,
              timestamp: input.now,
              proposalKey: resolution.proposalKey,
              reason: resolution.reason,
            }),
          }
        : {}),
    });
  }

  return assignments;
}

export function buildProposalResolutionComment(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly action: ProposalResolutionAction;
  readonly proposalKey: string;
  readonly reason: string;
  readonly targetIssueNumber?: number;
  readonly linkedIssueNumber?: number;
  readonly linkedIssueUrl?: string;
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'proposal-intake',
    'agent-role': 'duplicate-resolution',
    repository: input.repository,
    'issue-number': input.issueNumber,
    'proposal-key': input.proposalKey,
    resolution: input.action,
    reason: input.reason,
    'target-issue-number': input.targetIssueNumber,
    'linked-issue-number': input.linkedIssueNumber,
    'linked-issue-url': input.linkedIssueUrl,
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  return [
    '🤖 Agent note (proposal-intake)',
    '',
    `Resolution: ${input.action}`,
    `Reason: ${input.reason}`,
    ...(input.targetIssueNumber ? [`Target issue: #${input.targetIssueNumber}`] : []),
    ...(input.linkedIssueNumber ? [`Linked issue: #${input.linkedIssueNumber}${input.linkedIssueUrl ? ` (${input.linkedIssueUrl})` : ''}`] : []),
    '',
    metadataBlock,
  ].join('\n');
}

export function buildProposalTargetLinkComment(input: {
  readonly repository: string;
  readonly sourceIssueNumber: number;
  readonly targetIssueNumber: number;
  readonly linkedIssueNumber?: number;
  readonly linkedIssueUrl?: string;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly proposalKey: string;
  readonly reason: string;
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'proposal-intake',
    'agent-role': 'duplicate-link',
    repository: input.repository,
    'issue-number': input.sourceIssueNumber,
    'target-issue-number': input.targetIssueNumber,
    'proposal-key': input.proposalKey,
    reason: input.reason,
    'linked-issue-number': input.linkedIssueNumber,
    'linked-issue-url': input.linkedIssueUrl,
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  return [
    '🤖 Agent note (proposal-intake)',
    '',
    `Linked follow-up created from proposal #${input.sourceIssueNumber}.`,
    ...(input.linkedIssueNumber ? [`Linked issue: #${input.linkedIssueNumber}${input.linkedIssueUrl ? ` (${input.linkedIssueUrl})` : ''}`] : []),
    `Reason: ${input.reason}`,
    '',
    metadataBlock,
  ].join('\n');
}

function buildProposalCreatedIssueBody(input: {
  readonly proposalTitle: string;
  readonly proposalBody: string;
  readonly proposalUrl: string;
  readonly sourceIssueNumber: number;
  readonly targetIssueNumber?: number;
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-stage': 'proposal-intake',
    'agent-role': 'created-issue',
    'source-issue-number': input.sourceIssueNumber,
    'target-issue-number': input.targetIssueNumber,
    'proposal-key': buildProposalKey(input.proposalTitle),
  });

  return [
    input.proposalBody.trim(),
    '',
    `Source proposal: #${input.sourceIssueNumber}`,
    `Source URL: ${input.proposalUrl}`,
    ...(input.targetIssueNumber ? [`Related existing issue: #${input.targetIssueNumber}`] : []),
    '',
    metadataBlock,
  ].join('\n');
}

// Checks only proposal-key, not action, so a proposal already resolved by any
// action (e.g. comment-existing) is not re-processed if the matched issue is
// later closed and the resolution would change to create-and-link.
function hasEquivalentProposalComment(
  comments: readonly ProposalIssueComment[],
  _action: ProposalResolutionAction,
  proposalKey: string,
): boolean {
  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'proposal-intake'
      && metadata?.['proposal-key'] === proposalKey;
  });
}
