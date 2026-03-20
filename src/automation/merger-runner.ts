import { buildAgentMetadataBlock } from './agent-feedback.js';
import { hasReviewLifecycleSignal } from './agent-workflow-state.js';
import { parseAgentMetadata } from './evaluator-runner.js';
import { resolveReviewThreadStates } from './review-resolution-state.js';
import { hasActiveReviewerLease } from './reviewer-runner.js';

export interface MergerPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly baseRefName?: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
}

export interface MergerThreadComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface MergerReviewArtifact {
  readonly id: number;
  readonly body: string;
  readonly submittedAt: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  readonly authorLogin: string;
}

export interface MergerReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly comments: readonly MergerReviewThreadComment[];
}

export interface MergerReviewThreadComment {
  readonly id: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface MergerCiCheck {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  readonly conclusion: 'success' | 'neutral' | 'skipped' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | null;
}

export interface MergerBranchProtection {
  readonly requiredApprovingReviewCount: number;
  readonly requiresCodeOwnerReviews: boolean;
  readonly allowedMergeMethods: readonly ('merge' | 'squash' | 'rebase')[];
}

export type MergeGateReason =
  | 'draft-pr'
  | 'human-hold'
  | 'agent-blocked'
  | 'review-in-progress'
  | 'missing-current-approval'
  | 'review-follow-up-pending'
  | 'unresolved-review-threads'
  | 'branch-protection-review-policy'
  | 'ci-not-green';

export interface EvaluateMergeGateInput {
  readonly repository: string;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly leaseTtlMinutes: number;
  readonly pullRequest: MergerPullRequest;
  readonly threadComments: readonly MergerThreadComment[];
  readonly reviews: readonly MergerReviewArtifact[];
  readonly reviewThreads: readonly MergerReviewThread[];
  readonly ciChecks: readonly MergerCiCheck[];
  readonly branchProtection?: MergerBranchProtection;
}

export interface MergeGateEvaluation {
  readonly ready: boolean;
  readonly reasons: readonly MergeGateReason[];
  readonly summary: string;
  readonly latestReviewerDecision?: 'approved' | 'changes-requested' | 'commented';
  readonly commentBody: string;
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
}

interface ReviewerDecisionEvent {
  readonly status: 'approved' | 'changes-requested' | 'commented';
  readonly timestamp: string;
  readonly headSha: string;
}

const BLOCKING_LABELS = new Set(['agent:blocked', 'human:hold']);
const SUCCESSFUL_CI_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const TERMINAL_REVIEW_STATUSES = new Set(['approved', 'changes-requested', 'commented']);

export function evaluateMergeGate(input: EvaluateMergeGateInput): MergeGateEvaluation {
  const labels = new Set(input.pullRequest.labels);
  const reasons = new Set<MergeGateReason>();

  if (input.pullRequest.draft) {
    reasons.add('draft-pr');
  }

  if (labels.has('human:hold')) {
    reasons.add('human-hold');
  }

  if (labels.has('agent:blocked')) {
    reasons.add('agent-blocked');
  }

  if (hasActiveReviewerLease({
    threadComments: input.threadComments,
    reviews: input.reviews,
    currentHeadSha: input.pullRequest.headSha,
    now: input.timestamp,
    leaseTtlMinutes: input.leaseTtlMinutes,
  })) {
    reasons.add('review-in-progress');
  }

  const latestReviewerDecision = findLatestReviewerDecision(input.reviews, input.threadComments, input.pullRequest.headSha);
  const reviewRequired = hasReviewLifecycleSignal(labels);
  if (reviewRequired && latestReviewerDecision?.status !== 'approved') {
    reasons.add('missing-current-approval');
  }

  if (hasReviewerFollowUpPending(input.reviewThreads, input.pullRequest.headSha, latestReviewerDecision?.timestamp)) {
    reasons.add('review-follow-up-pending');
  }

  const reviewThreadStates = resolveReviewThreadStates({
    reviewThreads: input.reviewThreads,
    currentHeadSha: input.pullRequest.headSha,
  });
  if (reviewThreadStates.some((thread) => thread.blocking)) {
    reasons.add('unresolved-review-threads');
  }

  if (requiresHumanBranchProtectionLane(input.branchProtection)) {
    reasons.add('branch-protection-review-policy');
  }

  if (!hasGreenCi(input.ciChecks)) {
    reasons.add('ci-not-green');
  }

  const ready = reasons.size === 0;
  const summary = buildMergeGateSummary(ready, [...reasons], latestReviewerDecision?.status);

  return {
    ready,
    reasons: [...reasons],
    summary,
    latestReviewerDecision: latestReviewerDecision?.status,
    commentBody: buildMergeGateEvaluationComment({
      repository: input.repository,
      pullRequestNumber: input.pullRequest.number,
      headSha: input.pullRequest.headSha,
      agentId: input.agentId,
      runId: input.runId,
      timestamp: input.timestamp,
      ready,
      summary,
      reasons: [...reasons],
    }),
    labelsToAdd: ready ? ['agent:ready-to-merge'] : [],
    labelsToRemove: ready ? [] : ['agent:ready-to-merge'],
  };
}

export function buildMergeGateEvaluationComment(input: {
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  agentId: string;
  runId: string;
  timestamp: string;
  ready: boolean;
  summary: string;
  reasons: readonly MergeGateReason[];
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'merger',
    'agent-role': 'merge-gate-evaluator',
    repository: input.repository,
    'pr-number': input.pullRequestNumber,
    'head-sha': input.headSha,
    status: input.ready ? 'ready-to-merge' : 'blocked',
    reasons: input.reasons.join(',') || 'none',
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  return [
    '🤖 Agent note (merger)',
    '',
    `Merge readiness: ${input.ready ? 'ready-to-merge' : 'blocked'}`,
    `Summary: ${input.summary}`,
    `Current head SHA: ${input.headSha}`,
    `Reasons: ${input.reasons.join(', ') || 'none'}`,
    '',
    metadataBlock,
  ].join('\n');
}

function findLatestReviewerDecision(
  reviews: readonly MergerReviewArtifact[],
  threadComments: readonly MergerThreadComment[],
  headSha: string,
): ReviewerDecisionEvent | undefined {
  const reviewEvents = reviews.flatMap((review) => toReviewerDecisionEvent(review.body, review.submittedAt));
  const commentEvents = threadComments.flatMap((comment) => toReviewerDecisionEvent(comment.body, comment.updatedAt));

  return [...reviewEvents, ...commentEvents]
    .filter((event) => event.headSha === headSha)
    .sort((left, right) => parseIsoTimestamp(left.timestamp) - parseIsoTimestamp(right.timestamp))
    .at(-1);
}

function toReviewerDecisionEvent(body: string, timestamp: string): ReviewerDecisionEvent[] {
  const metadata = parseAgentMetadata(body);
  if (!metadata) {
    return [];
  }

  if (metadata['agent-stage'] !== 'reviewer' || metadata['ignore-for-workflow'] === 'true') {
    return [];
  }

  const status = metadata.status;
  const headSha = metadata['head-sha'];
  if (!status || !headSha || !TERMINAL_REVIEW_STATUSES.has(status)) {
    return [];
  }

  return [{
    status: status as ReviewerDecisionEvent['status'],
    timestamp,
    headSha,
  }];
}

function hasReviewerFollowUpPending(
  reviewThreads: readonly MergerReviewThread[],
  currentHeadSha: string,
  latestReviewerDecisionTimestamp: string | undefined,
): boolean {
  return reviewThreads.some((thread) => {
    const agentComments = thread.comments.filter((comment) => isReviewerThreadComment(comment.body, currentHeadSha));
    if (agentComments.length === 0) {
      return false;
    }

    const latestAgentTimestamp = maxTimestamp(agentComments.map((comment) => comment.updatedAt));
    if (!latestAgentTimestamp) {
      return false;
    }

    const latestExternalReplyTimestamp = maxTimestamp(
      thread.comments
        .filter((comment) => !isReviewerThreadComment(comment.body, currentHeadSha))
        .filter((comment) => parseIsoTimestamp(comment.updatedAt) > parseIsoTimestamp(latestAgentTimestamp))
        .map((comment) => comment.updatedAt),
    );

    if (!latestExternalReplyTimestamp) {
      return false;
    }

    if (!latestReviewerDecisionTimestamp) {
      return true;
    }

    return parseIsoTimestamp(latestReviewerDecisionTimestamp) <= parseIsoTimestamp(latestExternalReplyTimestamp);
  });
}

function isReviewerThreadComment(body: string, currentHeadSha: string): boolean {
  const metadata = parseAgentMetadata(body);
  return metadata?.['agent-stage'] === 'reviewer'
    && metadata?.['ignore-for-workflow'] !== 'true'
    && metadata?.['head-sha'] === currentHeadSha;
}

function requiresHumanBranchProtectionLane(branchProtection: MergerBranchProtection | undefined): boolean {
  if (!branchProtection) {
    return false;
  }

  return branchProtection.requiredApprovingReviewCount > 1 || branchProtection.requiresCodeOwnerReviews;
}

function hasGreenCi(ciChecks: readonly MergerCiCheck[]): boolean {
  if (ciChecks.length === 0) {
    return false;
  }

  return ciChecks.every((check) => check.status === 'completed' && SUCCESSFUL_CI_CONCLUSIONS.has(check.conclusion ?? ''));
}

function buildMergeGateSummary(
  ready: boolean,
  reasons: readonly MergeGateReason[],
  latestReviewerDecision: ReviewerDecisionEvent['status'] | undefined,
): string {
  if (ready) {
    return 'All deterministic merge gates are satisfied for the current PR head.';
  }

  if (reasons.includes('missing-current-approval') && latestReviewerDecision) {
    return `Current head is not merge-ready because the latest reviewer decision is ${latestReviewerDecision}.`;
  }

  if (reasons.includes('branch-protection-review-policy')) {
    return 'Current head is not merge-ready because branch protection requires a human-controlled approval lane beyond the bounded single-agent reviewer.';
  }

  if (reasons.includes('review-follow-up-pending')) {
    return 'Current head is not merge-ready because reviewer-owned discussion threads received newer replies that still need agent follow-up.';
  }

  return `Merge gates are not yet satisfied: ${reasons.join(', ')}.`;
}

export function shouldSkipMergerByLabels(labels: readonly string[]): boolean {
  return labels.some((label) => BLOCKING_LABELS.has(label));
}

function maxTimestamp(values: readonly string[]): string | undefined {
  return values
    .slice()
    .sort((left, right) => parseIsoTimestamp(left) - parseIsoTimestamp(right))
    .at(-1);
}

function parseIsoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return timestamp;
}
