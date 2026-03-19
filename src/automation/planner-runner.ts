import { buildAgentMetadataBlock } from './agent-feedback.js';
import { planPlannerTransition } from './agent-workflow-state.js';
import { parseAgentMetadata } from './evaluator-runner.js';
import { findSemanticOpenDuplicate, type SemanticDuplicateBackendName } from './semantic-triage.js';

export interface PlannerIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
}

export interface PlannerIssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface PlannerDecision {
  readonly remainsSuitable: boolean;
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly plan?: string;
  readonly duplicateBackendName?: string;
}

export interface PlannerAssignment {
  readonly issueNumber: number;
  readonly remainsSuitable: boolean;
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly plan?: string;
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
  readonly commentBody: string;
}

export interface CollectPlannerAssignmentsInput {
  readonly issues: readonly PlannerIssue[];
  readonly commentsByIssueNumber: Readonly<Record<number, readonly PlannerIssueComment[]>>;
  readonly repository: string;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
  readonly semanticDuplicateBackendName?: SemanticDuplicateBackendName;
}

const RISK_KEYWORDS = ['security', 'auth', 'oauth', 'token', 'secret', 'tenant', 'migration', 'breaking', 'architecture', 'refactor'];
const STRUCTURE_HINTS = ['acceptance criteria', 'validation', '## ', '- [ ]', 'test'];

export function evaluatePlannerDecision(issue: PlannerIssue): PlannerDecision {
  const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
  const reasons: string[] = [];
  const hasRiskKeyword = RISK_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const hasStructureHint = STRUCTURE_HINTS.some((hint) => haystack.includes(hint));

  if (hasStructureHint) {
    reasons.push('issue body provides enough structure for a bounded implementation plan');
  } else {
    reasons.push('issue body is still too vague for bounded implementation');
  }

  if (hasRiskKeyword) {
    reasons.push('issue still matches high-risk keywords after deeper planning review');
  } else {
    reasons.push('issue remains inside the low-risk autonomous planning lane');
  }

  const remainsSuitable = hasStructureHint && !hasRiskKeyword;
  return {
    remainsSuitable,
    blocked: hasRiskKeyword,
    reasons,
    plan: remainsSuitable ? buildImplementationPlan(issue) : undefined,
  };
}

export function collectPlannerAssignments(input: CollectPlannerAssignmentsInput): PlannerAssignment[] {
  return input.issues.flatMap((issue) => {
    if (!isEligibleForPlannerQueue(issue)) {
      return [];
    }

    const baseDecision = evaluatePlannerDecision(issue);
    const duplicateMatch = findSemanticOpenDuplicate({
      stage: 'planner',
      issue,
      candidates: input.issues.filter((candidate) => candidate.number < issue.number && isPlannerActionableIssue(candidate)),
      backendName: input.semanticDuplicateBackendName,
    });
    const decision = duplicateMatch
      ? {
          remainsSuitable: false,
          blocked: baseDecision.blocked,
          reasons: [
            ...baseDecision.reasons,
            duplicateMatch.reason,
          ],
          plan: undefined,
          duplicateBackendName: duplicateMatch.backendName,
        }
      : baseDecision;
    const transition = planPlannerTransition({
      labels: issue.labels,
      remainsSuitable: decision.remainsSuitable,
      blocked: decision.blocked,
    });
    if (transition.labelsToAdd.length === 0 && transition.labelsToRemove.length === 0) {
      return [];
    }

    const commentBody = buildPlannerDecisionComment({
      repository: input.repository,
      issueNumber: issue.number,
      agentId: input.agentId,
      runId: input.runId,
      timestamp: input.now,
      remainsSuitable: decision.remainsSuitable,
      blocked: decision.blocked,
      reasons: decision.reasons,
      plan: decision.plan,
      duplicateBackendName: decision.duplicateBackendName,
    });

    if (hasEquivalentPlannerDecisionComment(input.commentsByIssueNumber[issue.number] ?? [], decision)) {
      return [];
    }

    return [{
      issueNumber: issue.number,
      remainsSuitable: decision.remainsSuitable,
      blocked: decision.blocked,
      reasons: decision.reasons,
      plan: decision.plan,
      labelsToAdd: transition.labelsToAdd,
      labelsToRemove: transition.labelsToRemove,
      commentBody,
    }];
  });
}

export function buildPlannerDecisionComment(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly remainsSuitable: boolean;
  readonly blocked: boolean;
  readonly reasons: readonly string[];
  readonly plan?: string;
  readonly duplicateBackendName?: string;
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'planner',
    'agent-role': 'implementation-plan',
    repository: input.repository,
    'issue-number': input.issueNumber,
    status: input.remainsSuitable ? 'planned' : input.blocked ? 'blocked' : 'de-scoped',
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
    '🤖 Agent plan (planner)',
    '',
    `Planner decision: ${input.remainsSuitable ? 'planned' : input.blocked ? 'blocked' : 'de-scoped'}`,
    'Reasons:',
    ...input.reasons.map((reason) => `- ${reason}`),
    ...duplicateGuardNote,
    ...(input.plan ? ['', input.plan] : []),
    '',
    metadataBlock,
  ].join('\n');
}

function buildImplementationPlan(issue: PlannerIssue): string {
  return [
    '## Implementation plan',
    `1. Confirm the narrow goal from issue #${issue.number} and keep changes bounded to the directly impacted module(s).`,
    '2. Add or update targeted success-path and failure-path tests before or alongside production changes.',
    '3. Implement the smallest modular change that satisfies the issue without broad refactors.',
    '4. Update user-facing docs or changelog entries if behavior becomes visible externally.',
    '',
    '### Validation',
    '- Run targeted unit tests for the touched area.',
    '- Run npm run typecheck.',
    '- Re-run the focused tests after the final refactor pass.',
  ].join('\n');
}

function isEligibleForPlannerQueue(issue: PlannerIssue): boolean {
  return isPlannerActionableIssue(issue);
}

function isPlannerActionableIssue(issue: PlannerIssue): boolean {
  const labels = new Set(issue.labels);
  return labels.has('agent:safe')
    && labels.has('agent:needs-plan')
    && !labels.has('human:hold')
    && !labels.has('agent:implementing')
    && !labels.has('agent:blocked');
}

function hasEquivalentPlannerDecisionComment(
  comments: readonly PlannerIssueComment[],
  decision: PlannerDecision,
): boolean {
  const expectedStatus = decision.remainsSuitable ? 'planned' : decision.blocked ? 'blocked' : 'de-scoped';
  const expectedReasons = decision.reasons.join(',');

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'planner'
      && metadata?.status === expectedStatus
      && metadata?.reasons === expectedReasons;
  });
}
