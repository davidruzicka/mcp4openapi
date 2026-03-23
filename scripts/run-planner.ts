import { readArtifactTrustConfig } from '../src/automation/artifact-signing-config.js';
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
  maxCandidates: 10,
  agentId: 'planner',
});

const artifactTrustConfig = readArtifactTrustConfig(process.env);
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
  semanticDuplicateBackendName: runtimeConfig.semanticDuplicateBackendName,
  artifactSigning: artifactTrustConfig.signing,
});

for (const assignment of assignments.slice(0, runtimeConfig.maxCandidates)) {
  await addIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToAdd);
  await removeIssueLabels(runtimeConfig, assignment.issueNumber, assignment.labelsToRemove);
  await createIssueComment(runtimeConfig, assignment.issueNumber, assignment.commentBody);
  process.stdout.write(`Planner processed issue #${assignment.issueNumber} (${assignment.remainsSuitable ? 'planned' : assignment.blocked ? 'blocked' : 'de-scoped'}).\n`);
}

process.stdout.write(`Planner runner completed. Processed ${Math.min(assignments.length, runtimeConfig.maxCandidates)} issue(s).\n`);
