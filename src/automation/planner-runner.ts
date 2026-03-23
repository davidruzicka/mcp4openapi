import { buildAgentMetadataBlock } from './agent-feedback.js';
import { planPlannerTransition } from './agent-workflow-state.js';
import { parseAgentMetadata } from './evaluator-runner.js';
import {
  inspectPlannerArtifactComment,
  parseTrustedPlannerArtifact,
  serializePlannerArtifact,
  type ReviewFixPlanArtifact,
} from './planner-artifact.js';
import type { ArtifactSigningConfig } from './artifact-signing.js';
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
  readonly plannerArtifact?: ReviewFixPlanArtifact;
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
  readonly artifactSigning?: ArtifactSigningConfig;
}

const RISK_KEYWORDS = ['security', 'auth', 'oauth', 'token', 'secret', 'tenant', 'migration', 'breaking', 'architecture', 'refactor'];
const STRUCTURE_HINTS = ['acceptance criteria', 'validation', '## ', '- [ ]', 'test'];

export function evaluatePlannerDecision(issue: PlannerIssue): PlannerDecision {
  const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
  const reasons: string[] = [];
  const hasRiskKeyword = RISK_KEYWORDS.some((keyword) => haystack.includes(keyword));
  const hasStructureHint = STRUCTURE_HINTS.some((hint) => haystack.includes(hint));
  const plannerArtifact = extractReviewFollowUpContext(issue.body);

  if (hasStructureHint || plannerArtifact) {
    reasons.push('issue body provides enough structure for a bounded implementation plan');
  } else {
    reasons.push('issue body is still too vague for bounded implementation');
  }

  if (hasRiskKeyword) {
    reasons.push('issue still matches high-risk keywords after deeper planning review');
  } else {
    reasons.push('issue remains inside the low-risk autonomous planning lane');
  }

  const remainsSuitable = (hasStructureHint || plannerArtifact !== undefined) && !hasRiskKeyword;
  return {
    remainsSuitable,
    blocked: hasRiskKeyword,
    reasons,
    plan: remainsSuitable ? buildImplementationPlan(issue, plannerArtifact) : undefined,
    plannerArtifact,
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
      plannerArtifact: decision.plannerArtifact,
      duplicateBackendName: decision.duplicateBackendName,
      artifactSigning: input.artifactSigning,
    });

    if (hasEquivalentPlannerDecisionComment(input.commentsByIssueNumber[issue.number] ?? [], decision, input.artifactSigning)) {
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
  readonly plannerArtifact?: ReviewFixPlanArtifact;
  readonly duplicateBackendName?: string;
  readonly artifactSigning?: ArtifactSigningConfig;
}): string {
  const plannerStatus = getPlannerDecisionStatus(input.remainsSuitable, input.blocked);
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'planner',
    'agent-role': 'implementation-plan',
    repository: input.repository,
    'issue-number': input.issueNumber,
    status: plannerStatus,
    reasons: input.reasons.join(','),
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  const lines = [
    '🤖 Agent plan (planner)',
    '',
    `Planner decision: ${plannerStatus}`,
    'Reasons:',
    ...input.reasons.map((reason) => `- ${reason}`),
    ...buildDuplicateGuardNoteLines(input.reasons, input.duplicateBackendName),
    ...(input.plan ? ['', input.plan] : []),
    ...(input.plannerArtifact ? ['', serializePlannerArtifact(input.plannerArtifact, { signing: input.artifactSigning })] : []),
    '',
    metadataBlock,
  ];

  return lines.join('\n');
}

function buildImplementationPlan(issue: PlannerIssue, plannerArtifact: ReviewFixPlanArtifact | undefined): string {
  if (plannerArtifact) {
    return [
      '## Review follow-up implementation plan',
      `1. Address review thread ${plannerArtifact.threadId} for head ${plannerArtifact.headSha}.`,
      ...plannerArtifact.implementationSteps.map((step, index) => `${index + 2}. ${step}`),
      '',
      '### Validation',
      ...plannerArtifact.testSteps.map((step) => `- ${step}`),
      ...plannerArtifact.verificationSteps.map((step) => `- ${step}`),
    ].join('\n');
  }

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
  artifactSigning: ArtifactSigningConfig | undefined,
): boolean {
  const expectedStatus = getPlannerDecisionStatus(decision.remainsSuitable, decision.blocked);
  const expectedReasons = decision.reasons.join(',');
  const expectedArtifact = decision.plannerArtifact;

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    if (
      metadata?.['agent-stage'] !== 'planner'
      || metadata?.status !== expectedStatus
      || metadata?.reasons !== expectedReasons
    ) {
      return false;
    }

    if (expectedArtifact === undefined) {
      return tryInspectPlannerArtifactComment(comment.body) === undefined;
    }

    const parsedArtifact = artifactSigning
      ? tryParseTrustedPlannerArtifactComment(comment.body, artifactSigning)
      : tryInspectPlannerArtifactComment(comment.body)?.artifact;

    return isSameReviewFixPlanArtifact(parsedArtifact, expectedArtifact);
  });
}

function tryInspectPlannerArtifactComment(body: string) {
  try {
    return inspectPlannerArtifactComment(body);
  } catch {
    return undefined;
  }
}

function tryParseTrustedPlannerArtifactComment(
  body: string,
  artifactSigning: ArtifactSigningConfig,
): ReviewFixPlanArtifact | undefined {
  try {
    return parseTrustedPlannerArtifact(body, {
      trustConfig: {
        allowUnsigned: false,
        signing: artifactSigning,
      },
    });
  } catch {
    return undefined;
  }
}

function isSameReviewFixPlanArtifact(
  left: ReviewFixPlanArtifact | undefined,
  right: ReviewFixPlanArtifact | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return left.kind === right.kind
    && left.threadId === right.threadId
    && left.sourceCommentId === right.sourceCommentId
    && left.headSha === right.headSha
    && left.fixSummary === right.fixSummary
    && arraysEqual(left.implementationSteps, right.implementationSteps)
    && arraysEqual(left.testSteps, right.testSteps)
    && arraysEqual(left.verificationSteps, right.verificationSteps);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function getPlannerDecisionStatus(remainsSuitable: boolean, blocked: boolean): 'planned' | 'blocked' | 'de-scoped' {
  if (remainsSuitable) {
    return 'planned';
  }

  return blocked ? 'blocked' : 'de-scoped';
}

function buildDuplicateGuardNoteLines(
  reasons: readonly string[],
  duplicateBackendName: string | undefined,
): string[] {
  const hasDuplicateGuardReason = reasons.some((reason) => {
    return reason.startsWith('issue appears to duplicate existing open issue #')
      || reason.startsWith('issue appears to semantically duplicate existing open issue #');
  });
  if (!hasDuplicateGuardReason) {
    return [];
  }

  return [
    '',
    `Semantic duplicate backend: ${duplicateBackendName ?? 'exact-title-fallback'}`,
    'Duplicate guard minimum fallback: exact open-title matches remain enforced even if semantic triage is unavailable.',
  ];
}

function extractReviewFollowUpContext(body: string): ReviewFixPlanArtifact | undefined {
  const threadId = body.match(/^Review thread:\s*(.+)$/im)?.[1]?.trim();
  const sourceCommentId = body.match(/^Source comment ID:\s*(.+)$/im)?.[1]?.trim();
  const headSha = body.match(/^Head SHA:\s*(.+)$/im)?.[1]?.trim();
  const fixSummary = body.match(/^Fix summary:\s*(.+)$/im)?.[1]?.trim();
  const implementationSteps = extractBulletSection(body, 'Implementation steps');
  const testSteps = extractBulletSection(body, 'Test steps');
  const verificationSteps = extractBulletSection(body, 'Verification steps');

  if (!threadId || !sourceCommentId || !headSha || !fixSummary || implementationSteps.length === 0 || testSteps.length === 0 || verificationSteps.length === 0) {
    return undefined;
  }

  return {
    kind: 'review-follow-up',
    threadId,
    sourceCommentId,
    headSha,
    fixSummary,
    implementationSteps,
    testSteps,
    verificationSteps,
  };
}

function extractBulletSection(body: string, heading: string): string[] {
  const match = body.match(new RegExp(`^${heading}:\\n([\\s\\S]*?)(?:\\n[A-Z][^\\n]*:|$)`, 'im'));
  if (!match) {
    return [];
  }

  return (match[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}
