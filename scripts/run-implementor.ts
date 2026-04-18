import { readArtifactTrustConfig } from '../src/automation/artifact-signing-config.js';
import {
  buildImplementorResultComment,
  buildImplementorReviewThreadReplyPlans,
  collectImplementorAssignments,
  planImplementorResultLabels,
  selectLatestTrustedPlannerArtifact,
  selectStaleImplementorCommentIds,
  type ImplementorCommandResult,
  type ImplementorTaskPayload,
} from '../src/automation/implementor-runner.js';
import { hasImplementorPullRequest } from '../src/automation/implementor-command-result.js';
import { runImplementorCommandWithFallback } from './implementor-command.js';
import type { ImplementorThreadReplyPayload } from '../src/automation/review-follow-up.js';
import {
  addIssueLabels,
  addPullRequestLabels,
  buildOpenPullRequestsByIssueNumber,
  createIssueComment,
  createReviewThreadReply,
  deleteIssueComment,
  getPullRequest,
  listIssueComments,
  listOpenPullRequests,
  listRecentIssues,
  mapIssueComment,
  mapIssueSummary,
  readIssueRuntimeConfig,
  removeIssueLabels,
  type IssueRuntimeConfig,
  updatePullRequestBody,
} from './github-agent-runtime.js';

const runtimeConfig = readIssueRuntimeConfig(process.env, 'IMPLEMENTOR', {
  lookbackHours: 72,
  maxCandidates: 5,
  agentId: 'implementor',
});
const implementorCommand = process.env.IMPLEMENTOR_COMMAND?.trim();
if (!implementorCommand) {
  process.stdout.write('Implementor runner skipped: IMPLEMENTOR_COMMAND is not configured.\n');
  process.exit(0);
}

const implementorFallbackCommand = process.env.IMPLEMENTOR_FALLBACK_COMMAND?.trim() || undefined;

const leaseTtlMinutes = parsePositiveInteger(process.env.IMPLEMENTOR_LEASE_TTL_MINUTES, 120);
const artifactTrustConfig = readArtifactTrustConfig(process.env);
const recentIssues = await listRecentIssues(runtimeConfig);
const commentsByIssueNumber: Record<number, ReturnType<typeof mapIssueComment>[]> = {};
for (const issue of recentIssues) {
  commentsByIssueNumber[issue.number] = (await listIssueComments(runtimeConfig, issue.number)).map(mapIssueComment);
}
const openPullRequestsByIssueNumber = buildOpenPullRequestsByIssueNumber(await listOpenPullRequests(runtimeConfig));

const assignments = collectImplementorAssignments({
  issues: recentIssues.map((issue) => {
    const mapped = mapIssueSummary(issue);
    return {
      number: mapped.number,
      title: mapped.title,
      body: mapped.body,
      url: mapped.url,
      updatedAt: mapped.updatedAt,
      labels: mapped.labels,
    };
  }),
  commentsByIssueNumber,
  openPullRequestsByIssueNumber,
  repository: runtimeConfig.repository,
  agentId: runtimeConfig.agentId,
  runId: runtimeConfig.runId,
  now: runtimeConfig.now,
  leaseTtlMinutes,
});

for (const assignment of assignments.slice(0, runtimeConfig.maxCandidates)) {
  const issue = recentIssues.find((candidate) => candidate.number === assignment.issueNumber);
  if (!issue) {
    throw new Error(`Missing issue snapshot for implementor assignment #${assignment.issueNumber}.`);
  }

  let plannerArtifact: ImplementorTaskPayload['plannerArtifact'];
  let reviewFollowUpItems: NonNullable<ImplementorTaskPayload['reviewFollowUpItems']> = [];
  let taskPayload: ImplementorTaskPayload = {
    repository: runtimeConfig.repository,
    issue: mapIssueSummary(issue),
    reviewFollowUpItems,
    plannerArtifact,
    runId: runtimeConfig.runId,
    agentId: runtimeConfig.agentId,
    now: runtimeConfig.now,
  };

  let preflightBlockedResult: ImplementorCommandResult | undefined;
  try {
    plannerArtifact = selectLatestTrustedPlannerArtifact(
      commentsByIssueNumber[assignment.issueNumber] ?? [],
      artifactTrustConfig,
    );
    reviewFollowUpItems = plannerArtifact
      ? [{
          threadId: plannerArtifact.threadId,
          headSha: plannerArtifact.headSha,
          sourceCommentId: plannerArtifact.sourceCommentId,
          summary: plannerArtifact.fixSummary,
          actionability: 'actionable' as const,
          requiresReply: true,
        }]
      : [];
    taskPayload = {
      repository: runtimeConfig.repository,
      issue: mapIssueSummary(issue),
      reviewFollowUpItems,
      plannerArtifact,
      runId: runtimeConfig.runId,
      agentId: runtimeConfig.agentId,
      now: runtimeConfig.now,
    };
  } catch (error) {
    preflightBlockedResult = {
      outcome: 'blocked',
      summary: error instanceof Error ? `Implementor preflight blocked: ${error.message}` : 'Implementor preflight blocked.',
    };
  }

  const result: ImplementorCommandResult = preflightBlockedResult ?? await (async () => {
    await addIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToAdd);
    await removeIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToRemove);
    await createIssueComment(runtimeConfig, assignment.issueNumber, assignment.leaseCommentBody);

    return await runImplementorCommandWithFallback(implementorCommand, implementorFallbackCommand, taskPayload, { timeoutMs: leaseTtlMinutes * 60 * 1000 }).catch((error: unknown) => ({
      outcome: 'failed',
      summary: error instanceof Error ? `Implementor command failed: ${error.message}` : 'Implementor command failed.',
    }));
  })();

  const labels = planImplementorResultLabels(result);
  await addIssueLabels(runtimeConfig, assignment.issueNumber, labels.issueLabelsToAdd);
  await removeIssueLabels(runtimeConfig, assignment.issueNumber, labels.issueLabelsToRemove);
  await createIssueComment(runtimeConfig, assignment.issueNumber, buildImplementorResultComment({
    repository: runtimeConfig.repository,
    issueNumber: assignment.issueNumber,
    agentId: runtimeConfig.agentId,
    runId: runtimeConfig.runId,
    timestamp: runtimeConfig.now,
    result,
    reviewFollowUpItems,
  }));

  await cleanupImplementorComments(runtimeConfig, assignment.issueNumber);

  if (hasImplementorPullRequest(result)) {
    const pullRequestNumber = result.pullRequest.number;

    await addPullRequestLabels(runtimeConfig, pullRequestNumber, labels.pullRequestLabelsToAdd);
    await ensurePullRequestDisclosure(runtimeConfig, pullRequestNumber, assignment.issueNumber);

    const pullRequest = await getPullRequest(runtimeConfig, pullRequestNumber);
    const newHeadSha = pullRequest.head.sha;
    const replyPlans = buildImplementorReviewThreadReplyPlans({
      task: taskPayload,
      result,
      newHeadSha,
    });

    await postImplementorReviewThreadReplies(runtimeConfig, pullRequestNumber, replyPlans);
  }

  process.stdout.write(`Implementor processed issue #${assignment.issueNumber} (${result.outcome}).\n`);
}

process.stdout.write(`Implementor runner completed. Processed ${Math.min(assignments.length, runtimeConfig.maxCandidates)} issue(s).\n`);

async function cleanupImplementorComments(
  runtimeConfig: IssueRuntimeConfig,
  issueNumber: number,
): Promise<void> {
  try {
    const latestComments = (await listIssueComments(runtimeConfig, issueNumber, { fetchAll: true })).map(mapIssueComment);
    const staleCommentIds = selectStaleImplementorCommentIds(latestComments);
    for (const commentId of staleCommentIds) {
      await deleteIssueComment(runtimeConfig, commentId);
    }
  } catch (error) {
    const summary = error instanceof Error ? error.message : 'unknown cleanup error';
    process.stdout.write(`Implementor comment cleanup skipped for issue #${issueNumber}: ${summary}.\n`);
  }
}

async function postImplementorReviewThreadReplies(
  runtimeConfig: IssueRuntimeConfig,
  pullRequestNumber: number,
  replyPlans: readonly ImplementorThreadReplyPayload[],
): Promise<void> {
  for (const replyPlan of replyPlans) {
    await createReviewThreadReply(runtimeConfig, {
      pullRequestNumber,
      threadId: replyPlan.threadId,
      inReplyToCommentId: replyPlan.inReplyToCommentId,
      body: replyPlan.body,
    });
  }
}

async function ensurePullRequestDisclosure(config: typeof runtimeConfig, pullRequestNumber: number, issueNumber: number): Promise<void> {
  const pullRequest = await getPullRequest(config, pullRequestNumber);
  const body = pullRequest.body ?? '';
  if (body.toLowerCase().includes('🤖') || body.toLowerCase().includes('automated agent')) {
    return;
  }

  const disclosure = [
    '> 🤖 This PR was created by an automated agent.',
    `> Agent: ${config.agentId}`,
    `> Source issue: #${issueNumber}`,
    `> Workflow run: ${config.runId}`,
    '',
  ].join('\n');
  await updatePullRequestBody(config, pullRequestNumber, `${disclosure}${body}`.trim());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }

  return parsed;
}
