import { parseAgentMetadata } from '../src/automation/evaluator-runner.js';
import { planMergeExecution, type MergeMethod } from '../src/automation/merge-executor.js';
import {
  createIssueComment,
  getPullRequest,
  listCiChecks,
  listIssueComments,
  listPullRequestReviews,
  listRecentPullRequests,
  listReviewThreads,
  mergePullRequest,
  readMergerRuntimeConfig,
  removeIssueLabels,
} from './merger-runtime.js';

const runtimeConfig = readMergerRuntimeConfig(process.env, {
  lookbackHoursVar: 'MERGE_EXECUTOR_LOOKBACK_HOURS',
  maxPrsVar: 'MERGE_EXECUTOR_MAX_PRS',
  leaseTtlMinutesVar: 'MERGE_EXECUTOR_LEASE_TTL_MINUTES',
  agentIdVar: 'MERGE_EXECUTOR_AGENT_ID',
});
const mergeMethod = readMergeMethod(process.env.MERGE_EXECUTOR_METHOD);
const recentPullRequests = await listRecentPullRequests(runtimeConfig);
const candidates = recentPullRequests
  .filter((pullRequest) => pullRequest.labels.includes('agent:ready-to-merge'))
  .slice(0, runtimeConfig.maxPrs);

for (const candidate of candidates) {
  const pullRequest = await getPullRequest(runtimeConfig, candidate.number);
  const threadComments = await listIssueComments(runtimeConfig, pullRequest.number);
  const reviews = await listPullRequestReviews(runtimeConfig, pullRequest.number);
  const reviewThreads = await listReviewThreads(runtimeConfig, pullRequest.number);
  const ciChecks = await listCiChecks(runtimeConfig, pullRequest.headSha);

  const execution = planMergeExecution({
    repository: runtimeConfig.repository,
    agentId: runtimeConfig.agentId,
    runId: runtimeConfig.runId,
    timestamp: runtimeConfig.now,
    leaseTtlMinutes: runtimeConfig.leaseTtlMinutes,
    expectedHeadSha: candidate.headSha,
    mergeMethod,
    pullRequest,
    threadComments,
    reviews,
    reviewThreads,
    ciChecks,
  });

  if (!execution.shouldMerge) {
    await removeIssueLabels(runtimeConfig, pullRequest.number, execution.labelsToRemove);

    if (!hasEquivalentMergeExecutorComment(threadComments, pullRequest.headSha, execution.reasons, 'skipped')) {
      await createIssueComment(runtimeConfig, pullRequest.number, execution.commentBody);
    }

    process.stdout.write(`Skipped merge for PR #${pullRequest.number}: ${execution.reasons.join(', ') || 'none'}.\n`);
    continue;
  }

  const mergeResponse = await mergePullRequest(runtimeConfig, pullRequest.number, pullRequest.headSha, execution.mergeMethod);
  if (!mergeResponse.merged) {
    throw new Error(`GitHub merge API did not merge PR #${pullRequest.number}: ${mergeResponse.message ?? 'unknown response'}`);
  }

  await removeIssueLabels(runtimeConfig, pullRequest.number, execution.labelsToRemove);

  if (!hasEquivalentMergeExecutorComment(threadComments, pullRequest.headSha, execution.reasons, 'merged')) {
    await createIssueComment(runtimeConfig, pullRequest.number, execution.commentBody);
  }

  process.stdout.write(`Merged PR #${pullRequest.number} with method ${execution.mergeMethod} at ${mergeResponse.sha ?? pullRequest.headSha}.\n`);
}

process.stdout.write(`Merge executor completed. Processed ${candidates.length} PR(s).\n`);

function hasEquivalentMergeExecutorComment(
  comments: readonly { body: string }[],
  headSha: string,
  reasons: readonly string[],
  status: 'merged' | 'skipped',
): boolean {
  const expectedReasons = reasons.join(',');

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'merger'
      && metadata?.['agent-role'] === 'merge-executor'
      && metadata?.['head-sha'] === headSha
      && metadata?.status === status
      && (metadata?.reasons ?? '') === expectedReasons;
  });
}

function readMergeMethod(value: string | undefined): MergeMethod {
  if (!value) {
    return 'squash';
  }

  if (value === 'merge' || value === 'squash' || value === 'rebase') {
    return value;
  }

  throw new Error(`Invalid MERGE_EXECUTOR_METHOD value: ${value}`);
}
