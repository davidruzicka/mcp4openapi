import { execFileSync } from 'node:child_process';
import {
  buildProposalResolutionComment,
  buildProposalTargetLinkComment,
  collectProposalAssignments,
} from '../src/automation/proposal-intake-runner.js';
import { rankProposalCandidateMatches } from '../src/automation/proposal-intake.js';
import { parseAgentMetadata } from '../src/automation/evaluator-runner.js';
import {
  createIssueComment,
  createRepositoryIssue,
  listIssueComments,
  listOpenPullRequests,
  listRecentClosedIssues,
  listRecentClosedPullRequests,
  listRecentIssues,
  mapIssueComment,
  mapIssueSummary,
  mapIssueSummaryToProposalCandidate,
  mapPullRequestSummaryToProposalCandidate,
  readIssueRuntimeConfig,
} from './github-agent-runtime.js';

const runtimeConfig = readIssueRuntimeConfig(process.env, 'PROPOSAL_INTAKE', {
  lookbackHours: 72,
  maxItems: 10,
  agentId: 'proposal-intake',
});

const recentIssues = await listRecentIssues(runtimeConfig);
const [recentClosedIssues, openPullRequests, recentClosedPullRequests] = await Promise.all([
  listRecentClosedIssues(runtimeConfig),
  listOpenPullRequests(runtimeConfig),
  listRecentClosedPullRequests(runtimeConfig),
]);

const commentsByIssueNumber: Record<number, ReturnType<typeof mapIssueComment>[]> = {};
for (const issue of recentIssues) {
  commentsByIssueNumber[issue.number] = (await listIssueComments(runtimeConfig, issue.number)).map(mapIssueComment);
}

const candidateArtifacts = [
  ...recentIssues.map(mapIssueSummaryToProposalCandidate),
  ...recentClosedIssues.map((issue) => ({
    ...mapIssueSummaryToProposalCandidate(issue),
    state: 'closed' as const,
  })),
  ...openPullRequests.map(mapPullRequestSummaryToProposalCandidate),
  ...recentClosedPullRequests.map(mapPullRequestSummaryToProposalCandidate),
];

const proposals = recentIssues.map((issue) => {
  const mappedIssue = mapIssueSummary(issue);
  return {
    proposalTitle: mappedIssue.title,
    proposalBody: mappedIssue.body,
    proposalUrl: mappedIssue.url,
    issueNumber: mappedIssue.number,
    matches: rankProposalCandidateMatches({
      proposalNumber: mappedIssue.number,
      proposalTitle: mappedIssue.title,
      proposalBody: mappedIssue.body,
      candidates: candidateArtifacts,
      maxMatches: runtimeConfig.maxItems,
    }),
  };
});

const assignments = collectProposalAssignments({
  proposals,
  commentsByIssueNumber,
  repository: runtimeConfig.repository,
  agentId: runtimeConfig.agentId,
  runId: runtimeConfig.runId,
  now: runtimeConfig.now,
  maxActions: 1,
  worktreeDirty: isWorktreeDirty(),
});

for (const assignment of assignments) {
  if (assignment.action === 'comment-existing') {
    await createIssueComment(runtimeConfig, assignment.issueNumber, assignment.commentBody);
    process.stdout.write(`Proposal intake processed issue #${assignment.issueNumber} (${assignment.action}).\n`);
    continue;
  }

  if ((assignment.action === 'create-fresh' || assignment.action === 'create-and-link')
    && assignment.createdIssueTitle
    && assignment.createdIssueBody) {
    const createdIssue = await createRepositoryIssue(runtimeConfig, {
      title: assignment.createdIssueTitle,
      body: assignment.createdIssueBody,
      labels: assignment.createdIssueLabels,
    });

    if (assignment.action === 'create-and-link' && assignment.targetIssueNumber) {
      const targetComments = (await listIssueComments(runtimeConfig, assignment.targetIssueNumber)).map(mapIssueComment);
      if (!hasEquivalentTargetLinkComment(targetComments, assignment.issueNumber, assignment.proposalKey, createdIssue.number)) {
        await createIssueComment(runtimeConfig, assignment.targetIssueNumber, buildProposalTargetLinkComment({
          repository: runtimeConfig.repository,
          sourceIssueNumber: assignment.issueNumber,
          targetIssueNumber: assignment.targetIssueNumber,
          linkedIssueNumber: createdIssue.number,
          linkedIssueUrl: createdIssue.html_url,
          agentId: runtimeConfig.agentId,
          runId: runtimeConfig.runId,
          timestamp: runtimeConfig.now,
          proposalKey: assignment.proposalKey,
          reason: assignment.reason,
        }));
      }
    }

    await createIssueComment(runtimeConfig, assignment.issueNumber, buildProposalResolutionComment({
      repository: runtimeConfig.repository,
      issueNumber: assignment.issueNumber,
      agentId: runtimeConfig.agentId,
      runId: runtimeConfig.runId,
      timestamp: runtimeConfig.now,
      action: assignment.action,
      proposalKey: assignment.proposalKey,
      reason: assignment.reason,
      targetIssueNumber: assignment.targetIssueNumber,
      linkedIssueNumber: createdIssue.number,
      linkedIssueUrl: createdIssue.html_url,
    }));
    process.stdout.write(`Proposal intake processed issue #${assignment.issueNumber} (${assignment.action} -> #${createdIssue.number}).\n`);
    continue;
  }

  process.stdout.write(`Proposal intake skipped unsupported assignment for issue #${assignment.issueNumber} (${assignment.action}).\n`);
}

process.stdout.write(`Proposal intake runner completed. Processed ${assignments.length} issue(s).\n`);

function hasEquivalentTargetLinkComment(
  comments: readonly ReturnType<typeof mapIssueComment>[],
  sourceIssueNumber: number,
  proposalKey: string,
  linkedIssueNumber: number,
): boolean {
  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'proposal-intake'
      && metadata?.['agent-role'] === 'duplicate-link'
      && metadata?.['issue-number'] === String(sourceIssueNumber)
      && metadata?.['proposal-key'] === proposalKey
      && metadata?.['linked-issue-number'] === String(linkedIssueNumber);
  });
}

function isWorktreeDirty(): boolean {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim().length > 0;
  } catch {
    return true;
  }
}
