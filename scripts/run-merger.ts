import { parseAgentMetadata } from '../src/automation/evaluator-runner.js';
import { evaluateMergeGate } from '../src/automation/merger-runner.js';
import {
  addIssueLabels,
  createIssueComment,
  listCiChecks,
  listIssueComments,
  listPullRequestReviews,
  listRecentPullRequests,
  listReviewThreads,
  readMergerRuntimeConfig,
  removeIssueLabels,
} from './merger-runtime.js';

const runtimeConfig = readMergerRuntimeConfig(process.env);
const recentPullRequests = await listRecentPullRequests(runtimeConfig);
const relevantPullRequests = recentPullRequests.filter((pullRequest) => {
  const labels = new Set(pullRequest.labels);
  return labels.has('agent:review:required') || labels.has('agent:review:done') || labels.has('agent:ready-to-merge');
});

for (const pullRequest of relevantPullRequests.slice(0, runtimeConfig.maxPrs)) {
  const threadComments = await listIssueComments(runtimeConfig, pullRequest.number);
  const reviews = await listPullRequestReviews(runtimeConfig, pullRequest.number);
  const reviewThreads = await listReviewThreads(runtimeConfig, pullRequest.number);
  const ciChecks = await listCiChecks(runtimeConfig, pullRequest.headSha);

  const evaluation = evaluateMergeGate({
    repository: runtimeConfig.repository,
    agentId: runtimeConfig.agentId,
    runId: runtimeConfig.runId,
    timestamp: runtimeConfig.now,
    leaseTtlMinutes: runtimeConfig.leaseTtlMinutes,
    pullRequest,
    threadComments,
    reviews,
    reviewThreads,
    ciChecks,
  });

  await addIssueLabels(runtimeConfig, pullRequest.number, evaluation.labelsToAdd);
  await removeIssueLabels(runtimeConfig, pullRequest.number, evaluation.labelsToRemove);

  if (!hasEquivalentMergerComment(threadComments, pullRequest.headSha, evaluation.ready, evaluation.reasons)) {
    await createIssueComment(runtimeConfig, pullRequest.number, evaluation.commentBody);
  }

  process.stdout.write(`Evaluated merge gate for PR #${pullRequest.number}: ${evaluation.ready ? 'ready' : 'blocked'} (${evaluation.reasons.join(', ') || 'none'}).\n`);
}

process.stdout.write(`Merger runner completed. Processed ${Math.min(relevantPullRequests.length, runtimeConfig.maxPrs)} PR(s).\n`);

function hasEquivalentMergerComment(
  comments: readonly { body: string }[],
  headSha: string,
  ready: boolean,
  reasons: readonly string[],
): boolean {
  const expectedStatus = ready ? 'ready-to-merge' : 'blocked';
  const expectedReasons = reasons.join(',');

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'merger'
      && metadata?.['agent-role'] === 'merge-gate-evaluator'
      && metadata?.['head-sha'] === headSha
      && metadata?.status === expectedStatus
      && (metadata?.reasons ?? '') === expectedReasons;
  });
}
