import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildImplementorResultComment,
  buildImplementorReviewThreadReplyPlans,
  collectImplementorAssignments,
  parseImplementorCommandResult,
  planImplementorResultLabels,
  type ImplementorCommandResult,
} from '../src/automation/implementor-runner.js';
import { parsePlannerArtifact } from '../src/automation/planner-artifact.js';
import {
  addIssueLabels,
  addPullRequestLabels,
  buildOpenPullRequestsByIssueNumber,
  createIssueComment,
  createReviewThreadReply,
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

const execFileAsync = promisify(execFile);
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

const leaseTtlMinutes = parsePositiveInteger(process.env.IMPLEMENTOR_LEASE_TTL_MINUTES, 120);
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
  await addIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToAdd);
  await removeIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToRemove);
  await createIssueComment(runtimeConfig, assignment.issueNumber, assignment.leaseCommentBody);

  const issue = recentIssues.find((candidate) => candidate.number === assignment.issueNumber);
  if (!issue) {
    throw new Error(`Missing issue snapshot for implementor assignment #${assignment.issueNumber}.`);
  }

  const plannerArtifact = (commentsByIssueNumber[assignment.issueNumber] ?? [])
    .map((comment) => parsePlannerArtifact(comment.body))
    .find((artifact) => artifact !== undefined);
  const reviewFollowUpItems = plannerArtifact
    ? [{
        threadId: plannerArtifact.threadId,
        headSha: plannerArtifact.headSha,
        sourceCommentId: plannerArtifact.threadId,
        summary: plannerArtifact.fixSummary,
        actionability: 'actionable' as const,
        requiresReply: true,
      }]
    : [];

  const taskPayload = {
    repository: runtimeConfig.repository,
    issue: mapIssueSummary(issue),
    reviewFollowUpItems,
    plannerArtifact,
    runId: runtimeConfig.runId,
    agentId: runtimeConfig.agentId,
    now: runtimeConfig.now,
  };

  const result: ImplementorCommandResult = await runImplementorCommand(implementorCommand, taskPayload).catch((error: unknown) => ({
    outcome: 'failed',
    summary: error instanceof Error ? `Implementor command failed: ${error.message}` : 'Implementor command failed.',
  }));

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

  if (result.pullRequest) {
    const pullRequestNumber = result.pullRequest.number;

    await addPullRequestLabels(runtimeConfig, pullRequestNumber, labels.pullRequestLabelsToAdd);
    await ensurePullRequestDisclosure(runtimeConfig, pullRequestNumber, assignment.issueNumber);

    const newHeadSha = plannerArtifact?.headSha ?? `pr-${pullRequestNumber}`;
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

async function runImplementorCommand(command: string, payload: unknown) {
  const { stdout } = await execFileAsync('bash', ['-lc', command], {
    env: {
      ...process.env,
      IMPLEMENTOR_TASK_JSON: JSON.stringify(payload),
    },
    maxBuffer: 2 * 1024 * 1024,
  });

  return parseImplementorCommandResult(stdout.trim());
}

async function postImplementorReviewThreadReplies(
  runtimeConfig: IssueRuntimeConfig,
  pullRequestNumber: number,
  replyPlans: ReadonlyArray<{ readonly threadId: string; readonly body: string }>,
): Promise<void> {
  for (const replyPlan of replyPlans) {
    await createReviewThreadReply(runtimeConfig, {
      pullRequestNumber,
      threadId: replyPlan.threadId,
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
