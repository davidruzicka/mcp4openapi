import { detectIssueWorkflowState } from '../src/automation/agent-workflow-state.js';
import type { ProposalCandidateArtifact } from '../src/automation/proposal-intake.js';

interface GitHubLabel {
  readonly name: string;
}

export interface GitHubIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly updated_at: string;
  readonly pull_request?: Record<string, unknown>;
  readonly labels?: readonly GitHubLabel[];
}

interface GitHubIssueComment {
  readonly id: number;
  readonly body: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user?: {
    readonly login?: string;
  };
}

interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url: string;
  readonly draft: boolean;
  readonly updated_at: string;
  readonly state: 'open' | 'closed';
  readonly labels?: readonly GitHubLabel[];
  readonly head: {
    readonly sha: string;
    readonly ref: string;
  };
  readonly merged_at?: string | null;
}

export interface IssueRuntimeConfig {
  readonly repository: string;
  readonly token: string;
  readonly apiBaseUrl: string;
  readonly lookbackHours: number;
  readonly maxCandidates: number;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
}

export function readIssueRuntimeConfig(
  env: NodeJS.ProcessEnv,
  prefix: string,
  defaults: { readonly lookbackHours: number; readonly maxCandidates: number; readonly agentId: string; },
): IssueRuntimeConfig {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository) {
    throw new Error('Missing required GITHUB_REPOSITORY environment variable.');
  }
  if (!token) {
    throw new Error('Missing required GITHUB_TOKEN environment variable.');
  }

  const maxCandidates = parsePositiveInteger(
    env[`${prefix}_MAX_CANDIDATES`] ?? env[`${prefix}_MAX_ISSUES`] ?? env[`${prefix}_MAX_ITEMS`],
    defaults.maxCandidates,
  );

  return {
    repository,
    token,
    apiBaseUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    lookbackHours: parsePositiveInteger(env[`${prefix}_LOOKBACK_HOURS`], defaults.lookbackHours),
    maxCandidates,
    agentId: env[`${prefix}_AGENT_ID`] ?? defaults.agentId,
    runId: env.GITHUB_RUN_ID ? `github-actions-${env.GITHUB_RUN_ID}` : `manual-${Date.now()}`,
    now: env[`${prefix}_NOW`] ?? new Date().toISOString(),
  };
}

export async function listRecentIssues(config: IssueRuntimeConfig): Promise<GitHubIssueSummary[]> {
  return listRecentIssueSummaries(config, 'open');
}

export async function listRecentClosedIssues(config: IssueRuntimeConfig): Promise<GitHubIssueSummary[]> {
  return listRecentIssueSummaries(config, 'closed');
}

export async function listIssueComments(config: IssueRuntimeConfig, issueNumber: number): Promise<GitHubIssueComment[]> {
  return githubRequest<GitHubIssueComment[]>(config, `/repos/${config.repository}/issues/${issueNumber}/comments?per_page=100`);
}

export async function addIssueLabels(config: IssueRuntimeConfig, issueNumber: number, labels: readonly string[]): Promise<void> {
  if (labels.length === 0) {
    return;
  }

  await githubRequest(config, `/repos/${config.repository}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
}

export async function removeIssueLabels(config: IssueRuntimeConfig, issueNumber: number, labels: readonly string[]): Promise<void> {
  for (const label of labels) {
    const encodedLabel = encodeURIComponent(label);
    try {
      await githubRequest(config, `/repos/${config.repository}/issues/${issueNumber}/labels/${encodedLabel}`, {
        method: 'DELETE',
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('(404)')) {
        continue;
      }
      throw error;
    }
  }
}

export async function createIssueComment(config: IssueRuntimeConfig, issueNumber: number, body: string): Promise<void> {
  await githubRequest(config, `/repos/${config.repository}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function createRepositoryIssue(
  config: IssueRuntimeConfig,
  input: { readonly title: string; readonly body: string; readonly labels?: readonly string[] },
): Promise<GitHubIssueSummary> {
  return githubRequest<GitHubIssueSummary>(config, `/repos/${config.repository}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      labels: input.labels,
    }),
  });
}

export async function listOpenPullRequests(config: IssueRuntimeConfig): Promise<GitHubPullRequestSummary[]> {
  return listRecentPullRequests(config, 'open');
}

export async function listRecentClosedPullRequests(config: IssueRuntimeConfig): Promise<GitHubPullRequestSummary[]> {
  return listRecentPullRequests(config, 'closed');
}

export async function addPullRequestLabels(config: IssueRuntimeConfig, pullRequestNumber: number, labels: readonly string[]): Promise<void> {
  await addIssueLabels(config, pullRequestNumber, labels);
}

export async function getPullRequest(config: IssueRuntimeConfig, pullRequestNumber: number): Promise<GitHubPullRequestSummary> {
  return githubRequest<GitHubPullRequestSummary>(config, `/repos/${config.repository}/pulls/${pullRequestNumber}`);
}

export async function updatePullRequestBody(config: IssueRuntimeConfig, pullRequestNumber: number, body: string): Promise<void> {
  await githubRequest(config, `/repos/${config.repository}/pulls/${pullRequestNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

export function mapIssueSummary(issue: GitHubIssueSummary) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
    updatedAt: issue.updated_at,
    labels: (issue.labels ?? []).map((label) => label.name),
    isPullRequest: Boolean(issue.pull_request),
  };
}

export function mapIssueSummaryToProposalCandidate(issue: GitHubIssueSummary): ProposalCandidateArtifact {
  return {
    number: issue.number,
    kind: 'issue',
    state: 'open',
    workflowState: mapIssueWorkflowState((issue.labels ?? []).map((label) => label.name)),
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
  };
}

export function mapPullRequestSummaryToProposalCandidate(pullRequest: GitHubPullRequestSummary): ProposalCandidateArtifact {
  const workflowState = pullRequest.state === 'closed'
    ? (pullRequest.merged_at ? 'merged' : 'unknown')
    : 'implementing';

  return {
    number: pullRequest.number,
    kind: 'pull_request',
    state: pullRequest.state,
    workflowState,
    title: pullRequest.title,
    body: pullRequest.body ?? '',
    url: pullRequest.html_url,
  };
}

export function mapIssueComment(comment: GitHubIssueComment) {
  return {
    id: comment.id,
    body: comment.body ?? '',
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    authorLogin: comment.user?.login ?? 'unknown',
  };
}

export function buildOpenPullRequestsByIssueNumber(pullRequests: readonly GitHubPullRequestSummary[]): Record<number, number> {
  const mapping: Record<number, number> = {};
  for (const pullRequest of pullRequests) {
    const linkedIssueNumbers = extractLinkedIssueNumbers([pullRequest.title, pullRequest.body ?? ''].join('\n'));
    for (const issueNumber of linkedIssueNumbers) {
      mapping[issueNumber] = pullRequest.number;
    }
  }

  return mapping;
}

async function listRecentIssueSummaries(config: IssueRuntimeConfig, state: 'open' | 'closed'): Promise<GitHubIssueSummary[]> {
  const updatedSince = toIsoHoursAgo(config.now, config.lookbackHours);
  const issues = await githubRequest<GitHubIssueSummary[]>(config, `/repos/${config.repository}/issues?state=${state}&sort=updated&direction=desc&per_page=100&since=${encodeURIComponent(updatedSince)}`);
  return issues
    .filter((issue) => !issue.pull_request)
    .filter((issue) => issue.updated_at >= updatedSince)
    .slice(0, config.maxCandidates);
}

async function listRecentPullRequests(config: IssueRuntimeConfig, state: 'open' | 'closed'): Promise<GitHubPullRequestSummary[]> {
  const updatedSince = toIsoHoursAgo(config.now, config.lookbackHours);
  const pullRequests = await githubRequest<GitHubPullRequestSummary[]>(config, `/repos/${config.repository}/pulls?state=${state}&sort=updated&direction=desc&per_page=100`);
  return pullRequests
    .filter((pullRequest) => pullRequest.updated_at >= updatedSince)
    .slice(0, config.maxCandidates);
}

async function githubRequest<T = unknown>(config: IssueRuntimeConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}) for ${path}: ${await response.text()}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function extractLinkedIssueNumbers(text: string): number[] {
  const matches = text.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref(?:erence)?s?)\s+#(\d+)/gi);
  return [...new Set([...matches].map((match) => Number(match[1])).filter((value) => Number.isInteger(value) && value > 0))];
}

function mapIssueWorkflowState(labels: readonly string[]): ProposalCandidateArtifact['workflowState'] {
  const workflowState = detectIssueWorkflowState(labels);
  switch (workflowState) {
    case 'candidate':
    case 'needs-plan':
    case 'planned':
    case 'implementing':
    case 'blocked':
      return workflowState;
    case 'held':
      return 'blocked';
  }
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

function toIsoHoursAgo(now: string, hours: number): string {
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error(`Invalid runtime timestamp: ${now}`);
  }

  const sinceDate = new Date(nowDate.getTime() - hours * 60 * 60 * 1000);
  return sinceDate.toISOString();
}
