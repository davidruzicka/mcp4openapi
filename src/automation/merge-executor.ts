import { buildAgentMetadataBlock } from './agent-feedback.js';
import {
  evaluateMergeGate,
  type EvaluateMergeGateInput,
  type MergeGateReason,
} from './merger-runner.js';

export type FinalMergeReason = MergeGateReason | 'missing-ready-label' | 'head-sha-changed';
export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PlanMergeExecutionInput extends EvaluateMergeGateInput {
  readonly expectedHeadSha: string;
  readonly mergeMethod?: MergeMethod;
}

export interface MergeExecutionPlan {
  readonly shouldMerge: boolean;
  readonly reasons: readonly FinalMergeReason[];
  readonly summary: string;
  readonly mergeMethod: MergeMethod;
  readonly expectedHeadSha: string;
  readonly commentBody: string;
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
}

export function planMergeExecution(input: PlanMergeExecutionInput): MergeExecutionPlan {
  const mergeMethod = input.mergeMethod ?? 'squash';
  const reasons = new Set<FinalMergeReason>();
  const labels = new Set(input.pullRequest.labels);

  if (!labels.has('agent:ready-to-merge')) {
    reasons.add('missing-ready-label');
  }

  if (input.expectedHeadSha !== input.pullRequest.headSha) {
    reasons.add('head-sha-changed');
  }

  const evaluation = evaluateMergeGate(input);
  for (const reason of evaluation.reasons) {
    reasons.add(reason);
  }

  const shouldMerge = reasons.size === 0;
  const summary = buildMergeExecutionSummary({
    shouldMerge,
    reasons: [...reasons],
    gateSummary: evaluation.summary,
  });

  return {
    shouldMerge,
    reasons: [...reasons],
    summary,
    mergeMethod,
    expectedHeadSha: input.expectedHeadSha,
    commentBody: buildMergeExecutionComment({
      repository: input.repository,
      pullRequestNumber: input.pullRequest.number,
      headSha: input.pullRequest.headSha,
      expectedHeadSha: input.expectedHeadSha,
      agentId: input.agentId,
      runId: input.runId,
      timestamp: input.timestamp,
      shouldMerge,
      mergeMethod,
      summary,
      reasons: [...reasons],
    }),
    labelsToAdd: [],
    labelsToRemove: labels.has('agent:ready-to-merge') ? ['agent:ready-to-merge'] : [],
  };
}

export function buildMergeExecutionComment(input: {
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  expectedHeadSha: string;
  agentId: string;
  runId: string;
  timestamp: string;
  shouldMerge: boolean;
  mergeMethod: MergeMethod;
  summary: string;
  reasons: readonly FinalMergeReason[];
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': input.agentId,
    'agent-stage': 'merger',
    'agent-role': 'merge-executor',
    repository: input.repository,
    'pr-number': input.pullRequestNumber,
    'head-sha': input.headSha,
    'expected-head-sha': input.expectedHeadSha,
    'merge-method': input.mergeMethod,
    status: input.shouldMerge ? 'merged' : 'skipped',
    reasons: input.reasons.join(',') || 'none',
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  return [
    '🤖 Agent note (merge-executor)',
    '',
    `Merge execution: ${input.shouldMerge ? 'merged' : 'skipped'}`,
    `Summary: ${input.summary}`,
    `Current head SHA: ${input.headSha}`,
    `Expected head SHA: ${input.expectedHeadSha}`,
    `Merge method: ${input.mergeMethod}`,
    `Reasons: ${input.reasons.join(', ') || 'none'}`,
    '',
    metadataBlock,
  ].join('\n');
}

function buildMergeExecutionSummary(input: {
  shouldMerge: boolean;
  reasons: readonly FinalMergeReason[];
  gateSummary: string;
}): string {
  if (input.shouldMerge) {
    return 'Final merge revalidation passed for the current PR head.';
  }

  if (input.reasons.includes('head-sha-changed')) {
    return 'Final merge execution skipped because the PR head changed after ready-to-merge selection.';
  }

  if (input.reasons.includes('missing-ready-label')) {
    return 'Final merge execution skipped because the ready-to-merge label is missing.';
  }

  return `Final merge execution skipped because deterministic merge gates changed. ${input.gateSummary}`;
}
