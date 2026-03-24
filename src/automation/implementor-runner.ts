import { buildAgentMetadataBlock } from './agent-feedback.js';
import { planImplementorCompletion, planImplementorStart } from './agent-workflow-state.js';
import type { ArtifactTrustConfig } from './artifact-signing-config.js';
import { parseAgentMetadata } from './evaluator-runner.js';
import {
  parsePlannerArtifactValue,
  parseTrustedPlannerArtifact,
  type ReviewFixPlanArtifact,
} from './planner-artifact.js';
import { buildImplementorThreadReplyPlans, type ReviewFollowUpItem } from './review-follow-up.js';

export interface ImplementorIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
}

export interface ImplementorIssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface ImplementorCommandResult {
  readonly outcome: 'pr-created' | 'failed' | 'blocked';
  readonly summary: string;
  readonly pullRequest?: {
    readonly number: number;
    readonly url: string;
  };
}

export interface ImplementorResultLabelPlan {
  readonly issueLabelsToAdd: readonly string[];
  readonly issueLabelsToRemove: readonly string[];
  readonly pullRequestLabelsToAdd: readonly string[];
}

export interface ImplementorAssignment {
  readonly issueNumber: number;
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
  readonly leaseCommentBody: string;
}

export interface ImplementorTaskPayload {
  readonly repository: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly updatedAt: string;
    readonly labels: readonly string[];
    readonly isPullRequest: boolean;
  };
  readonly reviewFollowUpItems?: readonly ReviewFollowUpItem[];
  readonly plannerArtifact?: ReviewFixPlanArtifact;
  readonly runId: string;
  readonly agentId: string;
  readonly now: string;
}

export interface CollectImplementorAssignmentsInput {
  readonly issues: readonly ImplementorIssue[];
  readonly commentsByIssueNumber: Readonly<Record<number, readonly ImplementorIssueComment[]>>;
  readonly openPullRequestsByIssueNumber: Readonly<Record<number, number>>;
  readonly repository: string;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
  readonly leaseTtlMinutes?: number;
}

export function collectImplementorAssignments(input: CollectImplementorAssignmentsInput): ImplementorAssignment[] {
  const leaseTtlMinutes = input.leaseTtlMinutes ?? 45;

  return input.issues.flatMap((issue) => {
    const transition = planImplementorStart({
      labels: issue.labels,
      hasOpenPullRequest: input.openPullRequestsByIssueNumber[issue.number] !== undefined,
    });
    if (transition.labelsToAdd.length === 0 && transition.labelsToRemove.length === 0) {
      return [];
    }

    const comments = input.commentsByIssueNumber[issue.number] ?? [];
    if (hasActiveImplementorLease(comments, input.now, leaseTtlMinutes)) {
      return [];
    }

    return [{
      issueNumber: issue.number,
      labelsToAdd: transition.labelsToAdd,
      labelsToRemove: transition.labelsToRemove,
      leaseCommentBody: buildImplementorLeaseComment({
        repository: input.repository,
        issueNumber: issue.number,
        agentId: input.agentId,
        runId: input.runId,
        timestamp: input.now,
      }),
    }];
  });
}

export function buildImplementorLeaseComment(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'implementor',
    'agent-role': 'implementation',
    repository: input.repository,
    'issue-number': input.issueNumber,
    status: 'implementing',
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  return [
    '🤖 Agent implementation note (implementor)',
    '',
    `Implementation lease acquired for issue #${input.issueNumber}.`,
    '',
    metadataBlock,
  ].join('\n');
}

export function buildImplementorResultComment(input: {
  readonly repository: string;
  readonly issueNumber: number;
  readonly agentId: string;
  readonly runId: string;
  readonly timestamp: string;
  readonly result: ImplementorCommandResult;
  readonly reviewFollowUpItems?: readonly ReviewFollowUpItem[];
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'implementor',
    'agent-role': 'implementation',
    repository: input.repository,
    'issue-number': input.issueNumber,
    'pr-number': input.result.pullRequest?.number,
    status: input.result.outcome,
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  const lines = [
    '🤖 Agent implementation note (implementor)',
    '',
    `Implementation result: ${input.result.outcome}`,
    `Summary: ${input.result.summary}`,
  ];

  const pullRequestLine = buildImplementorPullRequestLine(input.result.pullRequest);
  if (pullRequestLine) {
    lines.push(pullRequestLine);
  }

  const reviewFollowUpCountLine = buildReviewFollowUpCountLine(input.reviewFollowUpItems);
  if (reviewFollowUpCountLine) {
    lines.push(reviewFollowUpCountLine);
  }

  lines.push('', metadataBlock);

  return lines.join('\n');
}

function buildImplementorPullRequestLine(pullRequest: ImplementorCommandResult['pullRequest']): string | undefined {
  if (!pullRequest) {
    return undefined;
  }

  return `PR: #${pullRequest.number} (${pullRequest.url})`;
}

function buildReviewFollowUpCountLine(reviewFollowUpItems: readonly ReviewFollowUpItem[] | undefined): string | undefined {
  if (!reviewFollowUpItems || reviewFollowUpItems.length === 0) {
    return undefined;
  }

  return `Review follow-up items: ${reviewFollowUpItems.length}`;
}

export interface ParseImplementorTaskPayloadOptions {
  readonly trustConfig?: ArtifactTrustConfig;
}

export function parseImplementorTaskPayload(
  raw: string | undefined,
  options?: ParseImplementorTaskPayloadOptions,
): ImplementorTaskPayload {
  if (!raw) {
    throw new Error('Missing IMPLEMENTOR_TASK_JSON payload for implementor workflow.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: expected JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: expected object payload.');
  }

  const candidate = parsed as Partial<ImplementorTaskPayload> & { plannerArtifact?: unknown };
  if (
    typeof candidate.repository !== 'string'
    || !candidate.issue
    || typeof candidate.issue.number !== 'number'
    || typeof candidate.issue.title !== 'string'
    || typeof candidate.issue.body !== 'string'
    || typeof candidate.issue.url !== 'string'
    || typeof candidate.runId !== 'string'
    || typeof candidate.agentId !== 'string'
    || typeof candidate.now !== 'string'
  ) {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: missing required workflow fields.');
  }

  const trustConfig = options?.trustConfig ?? { allowUnsigned: true };
  const plannerArtifact = parsePlannerArtifactFromTaskValue(candidate.plannerArtifact, trustConfig);
  if (candidate.plannerArtifact !== undefined && plannerArtifact === undefined) {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact must be a valid review-follow-up artifact.');
  }

  const reviewFollowUpItems = candidate.reviewFollowUpItems?.map(validateReviewFollowUpItem) ?? [];
  if (plannerArtifact && reviewFollowUpItems.length === 0) {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact requires reviewFollowUpItems.');
  }

  return {
    repository: candidate.repository,
    issue: {
      number: candidate.issue.number,
      title: candidate.issue.title,
      body: candidate.issue.body,
      url: candidate.issue.url,
      updatedAt: candidate.issue.updatedAt ?? '',
      labels: candidate.issue.labels ?? [],
      isPullRequest: candidate.issue.isPullRequest ?? false,
    },
    reviewFollowUpItems,
    plannerArtifact,
    runId: candidate.runId,
    agentId: candidate.agentId,
    now: candidate.now,
  };
}

function parsePlannerArtifactFromTaskValue(
  rawArtifact: unknown,
  trustConfig: ArtifactTrustConfig,
): ReviewFixPlanArtifact | undefined {
  if (rawArtifact === undefined) {
    return undefined;
  }

  if (typeof rawArtifact === 'string') {
    return parsePlannerArtifactFromTaskString(rawArtifact, trustConfig);
  }

  if (!rawArtifact || typeof rawArtifact !== 'object' || Array.isArray(rawArtifact)) {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact must be a valid review-follow-up artifact.');
  }

  if (isSignedPlannerArtifactEnvelope(rawArtifact)) {
    return parsePlannerArtifactFromTaskString(serializePlannerArtifactTaskValue(rawArtifact), trustConfig);
  }

  return parsePlannerArtifactFromTrustedTaskObject(rawArtifact);
}

function parsePlannerArtifactFromTrustedTaskObject(rawArtifact: unknown): ReviewFixPlanArtifact {
  try {
    return parsePlannerArtifactValue(rawArtifact);
  } catch {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact must be a valid review-follow-up artifact.');
  }
}

function isSignedPlannerArtifactEnvelope(rawArtifact: object): boolean {
  return ['version', 'algorithm', 'keyId', 'payload', 'signature'].some((key) => key in rawArtifact);
}

function serializePlannerArtifactTaskValue(rawArtifact: object): string {
  return [
    '<!-- AGENT-PLANNER-ARTIFACT',
    JSON.stringify(rawArtifact),
    '-->',
  ].join('\n');
}

function parsePlannerArtifactFromTaskString(rawArtifact: string, trustConfig: ArtifactTrustConfig): ReviewFixPlanArtifact | undefined {
  try {
    return parseTrustedPlannerArtifact(rawArtifact, { trustConfig });
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    if (error.message.includes('unsigned artifacts are not trusted')) {
      throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact must be signed or explicitly allowed unsigned.');
    }
    if (error.message.includes('signature verification failed')) {
      throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact signature verification failed.');
    }
    if (error.message.includes('signing key is not configured')) {
      throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact signing key is not configured.');
    }

    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: plannerArtifact must be a valid review-follow-up artifact.');
  }
}

export function selectLatestTrustedPlannerArtifact(
  comments: readonly ImplementorIssueComment[],
  trustConfig: ArtifactTrustConfig,
): ReviewFixPlanArtifact | undefined {
  const commentsNewestFirst = comments
    .filter(isExecutablePlannerArtifactComment)
    .map((comment, index) => ({ comment, index }))
    .sort((left, right) => {
      const timestampDelta = Date.parse(right.comment.createdAt) - Date.parse(left.comment.createdAt);
      return timestampDelta !== 0 ? timestampDelta : right.index - left.index;
    })
    .map(({ comment }) => comment);

  for (const comment of commentsNewestFirst) {
    const artifact = parseTrustedPlannerArtifact(comment.body, { trustConfig });
    if (artifact !== undefined) {
      return artifact;
    }
  }

  return undefined;
}

function isExecutablePlannerArtifactComment(comment: ImplementorIssueComment): boolean {
  const metadata = parseAgentMetadata(comment.body);
  return metadata?.['agent-stage'] === 'planner' && metadata.status !== 'blocked';
}

export function buildImplementorReviewThreadReplyPlans(input: {
  readonly task: ImplementorTaskPayload;
  readonly result: ImplementorCommandResult;
  readonly newHeadSha: string;
}) {
  if (
    !input.task.plannerArtifact
    || !input.task.reviewFollowUpItems
    || input.task.reviewFollowUpItems.length === 0
    || input.result.outcome !== 'pr-created'
    || !input.newHeadSha
  ) {
    return [];
  }

  return buildImplementorThreadReplyPlans({
    items: input.task.reviewFollowUpItems,
    newHeadSha: input.newHeadSha,
    resultSummary: input.result.summary,
  });
}

export function parseImplementorCommandResult(raw: string): ImplementorCommandResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid implementor command result: expected JSON object.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid implementor command result: expected object payload.');
  }

  const outcome = (parsed as { outcome?: unknown }).outcome;
  const summary = (parsed as { summary?: unknown }).summary;
  const pullRequest = (parsed as { pullRequest?: unknown }).pullRequest;
  if (outcome !== 'pr-created' && outcome !== 'failed' && outcome !== 'blocked') {
    throw new Error('Invalid implementor command result: unsupported outcome.');
  }
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error('Invalid implementor command result: missing summary.');
  }
  if (pullRequest !== undefined) {
    if (!pullRequest || typeof pullRequest !== 'object' || typeof (pullRequest as { number?: unknown }).number !== 'number' || typeof (pullRequest as { url?: unknown }).url !== 'string') {
      throw new Error('Invalid implementor command result: invalid pullRequest payload.');
    }
  }
  if (outcome === 'pr-created' && pullRequest === undefined) {
    throw new Error('Invalid implementor command result: pr-created outcome requires pullRequest metadata.');
  }

  return parsed as ImplementorCommandResult;
}

export function planImplementorResultLabels(result: ImplementorCommandResult): ImplementorResultLabelPlan {
  const issueTransition = planImplementorCompletion({
    labels: ['agent:implementing'],
    outcome: result.outcome,
  });

  return {
    issueLabelsToAdd: issueTransition.labelsToAdd,
    issueLabelsToRemove: issueTransition.labelsToRemove,
    pullRequestLabelsToAdd: result.outcome === 'pr-created' ? ['agent:created', 'agent:review:required'] : [],
  };
}

function validateReviewFollowUpItem(item: ReviewFollowUpItem): ReviewFollowUpItem {
  if (!item.threadId || !item.headSha || !item.sourceCommentId || !item.summary) {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload: reviewFollowUpItems must include threadId, headSha, sourceCommentId, and summary.');
  }

  return item;
}

function hasActiveImplementorLease(
  comments: readonly ImplementorIssueComment[],
  now: string,
  leaseTtlMinutes: number,
): boolean {
  const nowTimestamp = parseIsoTimestamp(now);
  const ttlMs = leaseTtlMinutes * 60 * 1000;

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    if (!metadata || metadata['agent-stage'] !== 'implementor') {
      return false;
    }

    if (metadata.status !== 'implementing' && !isPreflightBlockedCooldownComment(comment.body, metadata.status)) {
      return false;
    }

    return nowTimestamp - parseIsoTimestamp(comment.updatedAt) <= ttlMs;
  });
}

function isPreflightBlockedCooldownComment(body: string, status: string | undefined): boolean {
  return status === 'blocked' && body.includes('Summary: Implementor preflight blocked:');
}

function parseIsoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return timestamp;
}
