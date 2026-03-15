import { collectIssuerAssignments } from '../src/automation/issuer-runner.js';
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

const runtimeConfig = readIssueRuntimeConfig(process.env, 'ISSUER', {
  lookbackHours: 72,
  maxItems: 20,
  agentId: 'issuer',
});

const recentIssues = await listRecentIssues(runtimeConfig);
const commentsByIssueNumber: Record<number, ReturnType<typeof mapIssueComment>[]> = {};
for (const issue of recentIssues) {
  commentsByIssueNumber[issue.number] = (await listIssueComments(runtimeConfig, issue.number)).map(mapIssueComment);
}

const assignments = collectIssuerAssignments({
  issues: recentIssues.map(mapIssueSummary),
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
  process.stdout.write(`Issuer processed issue #${assignment.issueNumber} (${assignment.suitable ? 'safe' : 'unsafe'}).\n`);
}

process.stdout.write(`Issuer runner completed. Processed ${Math.min(assignments.length, runtimeConfig.maxItems)} issue(s).\n`);
