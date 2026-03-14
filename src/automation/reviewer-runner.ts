import { buildAgentMetadataBlock } from './agent-feedback.js';
import { parseAgentMetadata } from './evaluator-runner.js';

export interface ReviewerPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
}

export interface ReviewerThreadComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface ReviewerReviewArtifact {
  readonly id: number;
  readonly body: string;
  readonly submittedAt: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  readonly authorLogin: string;
}

export interface ReviewerLeaseCheckInput {
  readonly threadComments: readonly ReviewerThreadComment[];
  readonly reviews: readonly ReviewerReviewArtifact[];
  readonly currentHeadSha: string;
  readonly now: string;
  readonly leaseTtlMinutes: number;
}

export interface ReviewerAssignment {
  readonly pullRequestNumber: number;
  readonly reason: 'missing-current-review' | 'stale-review';
  readonly leaseCommentBody: string;
}

export interface CollectReviewerAssignmentsInput {
  readonly pullRequests: readonly ReviewerPullRequest[];
  readonly commentsByPrNumber: Readonly<Record<number, readonly ReviewerThreadComment[]>>;
  readonly reviewsByPrNumber: Readonly<Record<number, readonly ReviewerReviewArtifact[]>>;
  readonly repository: string;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
  readonly leaseTtlMinutes: number;
}

export interface BuildReviewerLeaseCommentInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly headSha: string;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly reason: ReviewerAssignment['reason'];
}

interface ReviewerMetadataEvent {
  readonly body: string;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, string>>;
}

const BLOCKING_LABELS = new Set(['agent:blocked', 'human:hold']);
const TERMINAL_REVIEW_STATUSES = new Set(['approved', 'changes-requested', 'commented']);

export function hasActiveReviewerLease(input: ReviewerLeaseCheckInput): boolean {
  const nowTimestamp = parseIsoTimestamp(input.now);
  const leaseTtlMs = input.leaseTtlMinutes * 60 * 1000;

  return listReviewerMetadataEvents(input.threadComments, input.reviews)
    .filter((event) => event.metadata.status === 'reviewing')
    .filter((event) => event.metadata['head-sha'] === input.currentHeadSha)
    .some((event) => nowTimestamp - parseIsoTimestamp(event.timestamp) <= leaseTtlMs);
}

export function collectReviewerAssignments(input: CollectReviewerAssignmentsInput): ReviewerAssignment[] {
  return input.pullRequests.flatMap((pullRequest) => {
    if (!isEligibleForReviewerQueue(pullRequest)) {
      return [];
    }

    const threadComments = input.commentsByPrNumber[pullRequest.number] ?? [];
    const reviews = input.reviewsByPrNumber[pullRequest.number] ?? [];
    if (hasActiveReviewerLease({
      threadComments,
      reviews,
      currentHeadSha: pullRequest.headSha,
      now: input.now,
      leaseTtlMinutes: input.leaseTtlMinutes,
    })) {
      return [];
    }

    const reviewerEvents = listReviewerMetadataEvents(threadComments, reviews);
    const hasCurrentDecision = reviewerEvents
      .filter((event) => event.metadata['head-sha'] === pullRequest.headSha)
      .some((event) => TERMINAL_REVIEW_STATUSES.has(event.metadata.status ?? ''));

    if (hasCurrentDecision) {
      return [];
    }

    const reason: ReviewerAssignment['reason'] = reviewerEvents.length > 0 ? 'stale-review' : 'missing-current-review';

    return [{
      pullRequestNumber: pullRequest.number,
      reason,
      leaseCommentBody: buildReviewerLeaseComment({
        repository: input.repository,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.headSha,
        agentId: input.agentId,
        runId: input.runId,
        timestamp: input.now,
        reason,
      }),
    }];
  });
}

export function buildReviewerLeaseComment(input: BuildReviewerLeaseCommentInput): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'reviewer',
    'agent-role': 'review',
    repository: input.repository,
    'pr-number': input.pullRequestNumber,
    'head-sha': input.headSha,
    reason: input.reason,
    status: 'reviewing',
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  return [
    '🤖 Agent note (reviewer)',
    '',
    `Reviewer lease acquired for PR #${input.pullRequestNumber}.`,
    `Reason: ${input.reason}.`,
    `Current head SHA: ${input.headSha}`,
    '',
    metadataBlock,
  ].join('\n');
}

function isEligibleForReviewerQueue(pullRequest: ReviewerPullRequest): boolean {
  if (pullRequest.draft) {
    return false;
  }

  const labels = new Set(pullRequest.labels);
  if (!labels.has('agent:review:required')) {
    return false;
  }

  return ![...BLOCKING_LABELS].some((label) => labels.has(label));
}

function listReviewerMetadataEvents(
  threadComments: readonly ReviewerThreadComment[],
  reviews: readonly ReviewerReviewArtifact[],
): ReviewerMetadataEvent[] {
  const commentEvents = threadComments.map((comment) => ({
    body: comment.body,
    timestamp: comment.updatedAt,
    metadata: parseAgentMetadata(comment.body),
  }));
  const reviewEvents = reviews.map((review) => ({
    body: review.body,
    timestamp: review.submittedAt,
    metadata: parseAgentMetadata(review.body),
  }));

  return [...commentEvents, ...reviewEvents]
    .filter((event): event is ReviewerMetadataEvent & { metadata: Readonly<Record<string, string>> } => event.metadata !== undefined)
    .filter((event) => event.metadata['agent-stage'] === 'reviewer')
    .filter((event) => event.metadata['ignore-for-workflow'] !== 'true')
    .sort((left, right) => parseIsoTimestamp(left.timestamp) - parseIsoTimestamp(right.timestamp));
}

function parseIsoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return timestamp;
}
