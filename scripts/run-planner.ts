import { collectPlannerAssignments } from '../src/automation/planner-runner.js';
import {
  addIssueLabels,
  createIssueComment,
  listIssueComments,
  listRecentIssues,
  mapIssueComment,
  mapIssueSummary,
  readIssueRuntimeConfig,
  removeIssueLabels,
} from './github-agent-runtime.js';

const runtimeConfig = readIssueRuntimeConfig(process.env, 'PLANNER', {
  lookbackHours: 72,
  maxItems: 10,
  agentId: 'planner',
});

const recentIssues = await listRecentIssues(runtimeConfig);
const commentsByIssueNumber: Record<number, ReturnType<typeof mapIssueComment>[]> = {};
for (const issue of recentIssues) {
  commentsByIssueNumber[issue.number] = (await listIssueComments(runtimeConfig, issue.number)).map(mapIssueComment);
}

const assignments = collectPlannerAssignments({
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
  repository: runtimeConfig.repository,
  agentId: runtimeConfig.agentId,
  runId: runtimeConfig.runId,
  now: runtimeConfig.now,
});

for (const assignment of assignments.slice(0, runtimeConfig.maxItems)) {
  await addIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToAdd);
  await removeIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToRemove);
  await createIssueComment(runtimeConfig, assignment.issueNumber, assignment.commentBody);
  process.stdout.write(`Planner processed issue #${assignment.issueNumber} (${assignment.remainsSuitable ? 'planned' : assignment.blocked ? 'blocked' : 'de-scoped'}).\n`);
}

process.stdout.write(`Planner runner completed. Processed ${Math.min(assignments.length, runtimeConfig.maxItems)} issue(s).\n`);
