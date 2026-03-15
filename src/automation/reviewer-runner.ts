import { buildAgentMetadataBlock } from './agent-feedback.js';
import { planReviewerCompletion, hasReviewLifecycleSignal } from './agent-workflow-state.js';
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

export interface ReviewerReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly comments: readonly ReviewerReviewThreadComment[];
}

export interface ReviewerReviewThreadComment {
  readonly id: string;
  readonly body: string;
  readonly updatedAt: string;
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
  readonly reason: 'missing-current-review' | 'stale-review' | 'follow-up-requested';
  readonly leaseCommentBody: string;
}

export interface CollectReviewerAssignmentsInput {
  readonly pullRequests: readonly ReviewerPullRequest[];
  readonly commentsByPrNumber: Readonly<Record<number, readonly ReviewerThreadComment[]>>;
  readonly reviewsByPrNumber: Readonly<Record<number, readonly ReviewerReviewArtifact[]>>;
  readonly reviewThreadsByPrNumber: Readonly<Record<number, readonly ReviewerReviewThread[]>>;
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

export interface ReviewerChangedFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string;
}

export interface ReviewerFinding {
  readonly category: 'missing-targeted-tests' | 'missing-agent-disclosure';
  readonly severity: 'low' | 'medium' | 'high';
  readonly summary: string;
  readonly files?: readonly string[];
}

export interface BuildSemanticReviewerDecisionInput {
  readonly repository: string;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly pullRequest: ReviewerPullRequest;
  readonly changedFiles: readonly ReviewerChangedFile[];
}

export interface SemanticReviewerDecision {
  readonly verdict: 'approved' | 'changes-requested' | 'commented';
  readonly summary: string;
  readonly findings: readonly ReviewerFinding[];
  readonly reviewBody: string;
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
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
    const reviewThreads = input.reviewThreadsByPrNumber[pullRequest.number] ?? [];
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
    const currentHeadEvents = reviewerEvents.filter((event) => event.metadata['head-sha'] === pullRequest.headSha);
    const hasCurrentDecision = currentHeadEvents.some((event) => TERMINAL_REVIEW_STATUSES.has(event.metadata.status ?? ''));
    const latestCurrentDecisionTimestamp = currentHeadEvents
      .filter((event) => TERMINAL_REVIEW_STATUSES.has(event.metadata.status ?? ''))
      .map((event) => event.timestamp)
      .sort((left, right) => parseIsoTimestamp(left) - parseIsoTimestamp(right))
      .at(-1);

    if (hasCurrentDecision && !hasReviewerFollowUpPending(reviewThreads, pullRequest.headSha, latestCurrentDecisionTimestamp)) {
      return [];
    }

    const reason: ReviewerAssignment['reason'] = hasCurrentDecision
      ? 'follow-up-requested'
      : reviewerEvents.length > 0 ? 'stale-review' : 'missing-current-review';

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

export function buildSemanticReviewerDecision(input: BuildSemanticReviewerDecisionInput): SemanticReviewerDecision {
  const findings = collectSemanticFindings(input.pullRequest, input.changedFiles);
  const verdict = selectReviewerVerdict(findings, input.changedFiles);
  const summary = buildReviewerSummary(verdict, findings, input.changedFiles);
  const reviewBody = buildReviewerDecisionComment({
    repository: input.repository,
    pullRequestNumber: input.pullRequest.number,
    headSha: input.pullRequest.headSha,
    agentId: input.agentId,
    runId: input.runId,
    timestamp: input.timestamp,
    verdict,
    summary,
    findings,
  });

  const reviewTransition = planReviewerCompletion(input.pullRequest.labels, verdict);

  return {
    verdict,
    summary,
    findings,
    reviewBody,
    labelsToAdd: reviewTransition.labelsToAdd,
    labelsToRemove: reviewTransition.labelsToRemove,
  };
}

function isEligibleForReviewerQueue(pullRequest: ReviewerPullRequest): boolean {
  if (pullRequest.draft) {
    return false;
  }

  const labels = new Set(pullRequest.labels);
  if (!hasReviewLifecycleSignal(labels)) {
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

function hasReviewerFollowUpPending(
  reviewThreads: readonly ReviewerReviewThread[],
  currentHeadSha: string,
  latestReviewerDecisionTimestamp: string | undefined,
): boolean {
  return reviewThreads.some((thread) => {
    const agentComments = thread.comments.filter((comment) => isReviewerThreadComment(comment.body, currentHeadSha));
    if (agentComments.length === 0) {
      return false;
    }

    const latestAgentTimestamp = agentComments
      .map((comment) => comment.updatedAt)
      .sort((left, right) => parseIsoTimestamp(left) - parseIsoTimestamp(right))
      .at(-1);
    if (!latestAgentTimestamp) {
      return false;
    }

    const latestExternalReplyTimestamp = thread.comments
      .filter((comment) => !isReviewerThreadComment(comment.body, currentHeadSha))
      .filter((comment) => parseIsoTimestamp(comment.updatedAt) > parseIsoTimestamp(latestAgentTimestamp))
      .map((comment) => comment.updatedAt)
      .sort((left, right) => parseIsoTimestamp(left) - parseIsoTimestamp(right))
      .at(-1);

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

function collectSemanticFindings(
  pullRequest: ReviewerPullRequest,
  changedFiles: readonly ReviewerChangedFile[],
): ReviewerFinding[] {
  const findings: ReviewerFinding[] = [];

  if (pullRequest.labels.includes('agent:created') && !hasVisibleAgentDisclosure(pullRequest.body)) {
    findings.push({
      category: 'missing-agent-disclosure',
      severity: 'high',
      summary: 'automation-created PR is missing visible agent disclosure in the PR body',
    });
  }

  const productionFiles = changedFiles.filter(isProductionChange);
  const hasTargetedTests = changedFiles.some(isTestChange);
  if (productionFiles.length > 0 && !hasTargetedTests) {
    findings.push({
      category: 'missing-targeted-tests',
      severity: 'high',
      summary: 'production changes appear to be missing targeted regression or failure-path tests',
      files: productionFiles.map((file) => file.filename),
    });
  }

  return findings;
}

function selectReviewerVerdict(
  findings: readonly ReviewerFinding[],
  changedFiles: readonly ReviewerChangedFile[],
): SemanticReviewerDecision['verdict'] {
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'changes-requested';
  }

  if (changedFiles.length > 0 && changedFiles.every(isDocumentationChange)) {
    return 'approved';
  }

  return findings.length === 0 ? 'approved' : 'commented';
}

function buildReviewerSummary(
  verdict: SemanticReviewerDecision['verdict'],
  findings: readonly ReviewerFinding[],
  changedFiles: readonly ReviewerChangedFile[],
): string {
  if (verdict === 'approved' && changedFiles.length > 0 && changedFiles.every(isDocumentationChange)) {
    return 'Docs-only changes look consistent and low risk.';
  }

  if (findings.length === 0) {
    return 'Current PR head looks consistent with the bounded reviewer policy checks.';
  }

  return findings[0]?.summary ?? 'Reviewer completed with non-blocking notes.';
}

function buildReviewerDecisionComment(input: {
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  agentId: string;
  runId: string;
  timestamp: string;
  verdict: SemanticReviewerDecision['verdict'];
  summary: string;
  findings: readonly ReviewerFinding[];
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'reviewer',
    'agent-role': 'review',
    repository: input.repository,
    'pr-number': input.pullRequestNumber,
    'head-sha': input.headSha,
    status: input.verdict,
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  const findingLines = input.findings.length === 0
    ? ['- No bounded-policy findings.']
    : input.findings.map((finding) => {
      const filesSuffix = finding.files && finding.files.length > 0
        ? ` [files: ${finding.files.join(', ')}]`
        : '';
      return `- ${finding.category} (${finding.severity}): ${finding.summary}${filesSuffix}`;
    });

  return [
    '🤖 Agent review (reviewer)',
    '',
    `Verdict: ${input.verdict}`,
    `Summary: ${input.summary}`,
    `Current head SHA: ${input.headSha}`,
    '',
    'Findings:',
    ...findingLines,
    '',
    metadataBlock,
  ].join('\n');
}

function hasVisibleAgentDisclosure(body: string): boolean {
  const normalized = body.toLowerCase();
  return normalized.includes('🤖')
    || normalized.includes('automated agent')
    || normalized.includes('agent-metadata');
}

function isDocumentationChange(file: ReviewerChangedFile): boolean {
  return file.filename.endsWith('.md')
    || file.filename.startsWith('docs/')
    || file.filename.startsWith('.github/ISSUE_TEMPLATE/');
}

function isTestChange(file: ReviewerChangedFile): boolean {
  return file.filename.endsWith('.test.ts')
    || file.filename.endsWith('.test.js')
    || file.filename.startsWith('tests/');
}

function isProductionChange(file: ReviewerChangedFile): boolean {
  if (isDocumentationChange(file) || isTestChange(file)) {
    return false;
  }

  return file.filename.endsWith('.ts')
    || file.filename.endsWith('.js')
    || file.filename.endsWith('.yml')
    || file.filename.endsWith('.yaml');
}

function parseIsoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return timestamp;
}
