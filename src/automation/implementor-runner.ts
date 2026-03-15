import { buildAgentMetadataBlock } from './agent-feedback.js';
import { planImplementorStart, planImplementorCompletion } from './agent-workflow-state.js';
import { parseAgentMetadata } from './evaluator-runner.js';

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

export interface ImplementorAssignment {
  readonly issueNumber: number;
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
  readonly leaseCommentBody: string;
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

  return [
    '🤖 Agent implementation note (implementor)',
    '',
    `Implementation result: ${input.result.outcome}`,
    `Summary: ${input.result.summary}`,
    ...(input.result.pullRequest ? [`PR: #${input.result.pullRequest.number} (${input.result.pullRequest.url})`] : []),
    '',
    metadataBlock,
  ].join('\n');
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

export function planImplementorResultLabels(result: ImplementorCommandResult): { readonly issueLabelsToAdd: readonly string[]; readonly issueLabelsToRemove: readonly string[]; readonly pullRequestLabelsToAdd: readonly string[]; } {
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

function hasActiveImplementorLease(
  comments: readonly ImplementorIssueComment[],
  now: string,
  leaseTtlMinutes: number,
): boolean {
  const nowTimestamp = parseIsoTimestamp(now);
  const ttlMs = leaseTtlMinutes * 60 * 1000;

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    if (metadata?.['agent-stage'] !== 'implementor' || metadata.status !== 'implementing') {
      return false;
    }

    return nowTimestamp - parseIsoTimestamp(comment.updatedAt) <= ttlMs;
  });
}

function parseIsoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return timestamp;
}
