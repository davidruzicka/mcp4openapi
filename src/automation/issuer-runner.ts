import { buildAgentMetadataBlock } from './agent-feedback.js';
import { isProposalIntakeCreatedIssue } from './agent-metadata-guards.js';
import { planIssuerTransition, hasBlockingWorkflowLabel } from './agent-workflow-state.js';
import { parseAgentMetadata } from './evaluator-runner.js';
import { findSemanticOpenDuplicate, type SemanticDuplicateBackendName } from './semantic-triage.js';

export interface IssuerIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly isPullRequest: boolean;
}

export interface IssuerIssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface IssuerDecision {
  readonly suitable: boolean;
  readonly reasons: readonly string[];
}

export interface IssuerAssignment {
  readonly issueNumber: number;
  readonly suitable: boolean;
  readonly reasons: readonly string[];
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
  readonly commentBody: string;
}

export interface CollectIssuerAssignmentsInput {
  readonly issues: readonly IssuerIssue[];
  readonly commentsByIssueNumber: Readonly<Record<number, readonly IssuerIssueComment[]>>;
  readonly repository: string;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
  readonly semanticDuplicateBackendName?: SemanticDuplicateBackendName;
}

const RISK_KEYWORDS = ['security', 'auth', 'oauth', 'token', 'secret', 'tenant', 'migration', 'breaking', 'architecture', 'refactor'];
const STRUCTURE_HINTS = ['acceptance criteria', 'validation', '## ', '- [ ]', 'test'];

export function evaluateIssueAutonomy(issue: IssuerIssue): IssuerDecision {
  const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
  const reasons: string[] = [];
  const hasRiskKeyword = RISK_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const hasStructureHint = STRUCTURE_HINTS.some((hint) => haystack.includes(hint));

  if (hasStructureHint) {
    reasons.push('issue includes explicit acceptance or validation structure');
  } else {
    reasons.push('issue lacks concrete acceptance or validation structure');
  }

  if (hasRiskKeyword) {
    reasons.push('issue matches high-risk keywords that should stay in a human lane');
  } else {
    reasons.push('issue stays within bounded autonomous risk heuristics');
  }

  return {
    suitable: hasStructureHint && !hasRiskKeyword,
    reasons,
  };
}

export function collectIssuerAssignments(input: CollectIssuerAssignmentsInput): IssuerAssignment[] {
  const eligibleIssues = input.issues.filter((issue) => isEligibleForIssuerQueue(issue));

  return eligibleIssues.flatMap((issue) => {
    if (wasCreatedByProposalIntake(issue)) {
      return [];
    }

    if (hasProposalIntakeDecisionComment(input.commentsByIssueNumber[issue.number] ?? [])) {
      return [];
    }

    const decision = evaluateIssueAutonomy(issue);
    const duplicateMatch = findSemanticOpenDuplicate({
      stage: 'issuer',
      issue,
      candidates: eligibleIssues.filter((candidate) => candidate.number < issue.number),
      backendName: input.semanticDuplicateBackendName,
    });
    const effectiveDecision = duplicateMatch
      ? {
          suitable: false,
          reasons: [
            ...decision.reasons,
            duplicateMatch.reason,
          ],
          duplicateBackendName: duplicateMatch.backendName,
        }
      : {
          ...decision,
          duplicateBackendName: undefined,
        };
    const transition = planIssuerTransition({
      labels: issue.labels,
      suitable: effectiveDecision.suitable,
    });
    if (transition.labelsToAdd.length === 0 && transition.labelsToRemove.length === 0) {
      return [];
    }

    const commentBody = buildIssuerDecisionComment({
      repository: input.repository,
      issueNumber: issue.number,
      agentId: input.agentId,
      runId: input.runId,
      timestamp: input.now,
      suitable: effectiveDecision.suitable,
      reasons: effectiveDecision.reasons,
      duplicateBackendName: effectiveDecision.duplicateBackendName,
    });

    if (hasEquivalentIssuerDecisionComment(input.commentsByIssueNumber[issue.number] ?? [], effectiveDecision.suitable, effectiveDecision.reasons)) {
      return [];
    }

    return [{
      issueNumber: issue.number,
      suitable: effectiveDecision.suitable,
      reasons: effectiveDecision.reasons,
      labelsToAdd: transition.labelsToAdd,
      labelsToRemove: transition.labelsToRemove,
      commentBody,
    }];
  });
}

export function buildIssuerDecisionComment(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly suitable: boolean;
  readonly reasons: readonly string[];
  readonly duplicateBackendName?: string;
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'issuer',
    'agent-role': 'issue-triage',
    repository: input.repository,
    'issue-number': input.issueNumber,
    status: input.suitable ? 'safe' : 'unsafe',
    reasons: input.reasons.join(','),
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  const duplicateGuardNote = input.reasons.some((reason) => reason.startsWith('issue appears to duplicate existing open issue #') || reason.startsWith('issue appears to semantically duplicate existing open issue #'))
    ? [
        '',
        `Semantic duplicate backend: ${input.duplicateBackendName ?? 'exact-title-fallback'}`,
        'Duplicate guard minimum fallback: exact open-title matches remain enforced even if semantic triage is unavailable.',
      ]
    : [];

  return [
    '🤖 Agent note (issuer)',
    '',
    `Autonomy gate decision: ${input.suitable ? 'safe' : 'unsafe'}`,
    'Reasons:',
    ...input.reasons.map((reason) => `- ${reason}`),
    ...duplicateGuardNote,
    '',
    metadataBlock,
  ].join('\n');
}

function isEligibleForIssuerQueue(issue: IssuerIssue): boolean {
  if (issue.isPullRequest) {
    return false;
  }

  if (issue.labels.includes('human:hold')) {
    return false;
  }

  if (hasBlockingWorkflowLabel(issue.labels.filter((label) => label === 'human:hold'))) {
    return false;
  }

  return !issue.labels.includes('agent:planned') && !issue.labels.includes('agent:implementing');
}

function hasEquivalentIssuerDecisionComment(
  comments: readonly IssuerIssueComment[],
  suitable: boolean,
  reasons: readonly string[],
): boolean {
  const expectedStatus = suitable ? 'safe' : 'unsafe';
  const expectedReasons = reasons.join(',');

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'issuer'
      && metadata?.status === expectedStatus
      && metadata?.reasons === expectedReasons;
  });
}

function hasProposalIntakeDecisionComment(comments: readonly IssuerIssueComment[]): boolean {
  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'proposal-intake'
      && metadata?.resolution !== undefined;
  });
}

function wasCreatedByProposalIntake(issue: IssuerIssue): boolean {
  return isProposalIntakeCreatedIssue(issue.body);
}
