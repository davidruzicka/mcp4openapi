import {
  evaluateMergeGate,
  type MergerCiCheck,
  type MergerPullRequest,
  type MergerReviewArtifact,
  type MergerReviewThread,
  type MergerThreadComment,
} from '../src/automation/merger-runner.js';
import { parseAgentMetadata } from '../src/automation/evaluator-runner.js';

interface GitHubLabel {
  readonly name: string;
}

interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly draft: boolean;
  readonly updated_at: string;
  readonly labels?: readonly GitHubLabel[];
  readonly head: {
    readonly sha: string;
  };
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

interface GitHubPullRequestReview {
  readonly id: number;
  readonly body: string | null;
  readonly submitted_at: string | null;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | string;
  readonly user?: {
    readonly login?: string;
  };
}

interface GitHubCheckRun {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed' | string;
  readonly conclusion: MergerCiCheck['conclusion'];
}

interface GitHubCheckRunsResponse {
  readonly check_runs?: readonly GitHubCheckRun[];
}

interface GitHubCommitStatus {
  readonly context: string;
  readonly state: 'pending' | 'success' | 'failure' | 'error';
}

interface GitHubCombinedStatusResponse {
  readonly statuses?: readonly GitHubCommitStatus[];
}

interface GraphQlReviewThreadsResponse {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly reviewThreads?: {
          readonly nodes?: ReadonlyArray<{
            readonly id: string;
            readonly isResolved: boolean;
          }>;
        };
      };
    };
  };
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
}

interface RuntimeConfig {
  readonly repository: string;
  readonly token: string;
  readonly apiBaseUrl: string;
  readonly graphQlUrl: string;
  readonly lookbackHours: number;
  readonly maxPrs: number;
  readonly leaseTtlMinutes: number;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
}

const runtimeConfig = readRuntimeConfig(process.env);
const recentPullRequests = await listRecentPullRequests(runtimeConfig);

for (const pullRequest of recentPullRequests.slice(0, runtimeConfig.maxPrs)) {
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

process.stdout.write(`Merger runner completed. Processed ${Math.min(recentPullRequests.length, runtimeConfig.maxPrs)} PR(s).\n`);

async function listRecentPullRequests(config: RuntimeConfig): Promise<MergerPullRequest[]> {
  const updatedSince = toIsoHoursAgo(config.now, config.lookbackHours);
  const pullRequests = await githubRequest<GitHubPullRequestSummary[]>(config, `/repos/${config.repository}/pulls?state=open&sort=updated&direction=desc&per_page=100`);

  return pullRequests
    .filter((pullRequest) => pullRequest.updated_at >= updatedSince)
    .filter((pullRequest) => {
      const labels = new Set((pullRequest.labels ?? []).map((label) => label.name));
      return labels.has('agent:review:required') || labels.has('agent:review:done') || labels.has('agent:ready-to-merge');
    })
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.html_url,
      draft: pullRequest.draft,
      headSha: pullRequest.head.sha,
      updatedAt: pullRequest.updated_at,
      labels: (pullRequest.labels ?? []).map((label) => label.name),
    } satisfies MergerPullRequest));
}

async function listIssueComments(config: RuntimeConfig, issueNumber: number): Promise<MergerThreadComment[]> {
  const comments = await githubRequest<GitHubIssueComment[]>(config, `/repos/${config.repository}/issues/${issueNumber}/comments?per_page=100`);
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body ?? '',
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    authorLogin: comment.user?.login ?? 'unknown',
  }));
}

async function listPullRequestReviews(config: RuntimeConfig, pullRequestNumber: number): Promise<MergerReviewArtifact[]> {
  const reviews = await githubRequest<GitHubPullRequestReview[]>(config, `/repos/${config.repository}/pulls/${pullRequestNumber}/reviews?per_page=100`);
  return reviews
    .filter((review): review is GitHubPullRequestReview & { submitted_at: string } => review.submitted_at !== null)
    .filter((review): review is GitHubPullRequestReview & { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; submitted_at: string } =>
      review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED')
    .map((review) => ({
      id: review.id,
      body: review.body ?? '',
      submittedAt: review.submitted_at,
      state: review.state,
      authorLogin: review.user?.login ?? 'unknown',
    }));
}

async function listReviewThreads(config: RuntimeConfig, pullRequestNumber: number): Promise<MergerReviewThread[]> {
  const [owner, repo] = splitRepository(config.repository);
  const response = await githubGraphQlRequest<GraphQlReviewThreadsResponse>(config, {
    query: `query ReviewThreads($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
            }
          }
        }
      }
    }`,
    variables: {
      owner,
      repo,
      prNumber: pullRequestNumber,
    },
  });

  if (response.errors && response.errors.length > 0) {
    throw new Error(`GitHub GraphQL request failed for reviewThreads: ${response.errors.map((error) => error.message).join('; ')}`);
  }

  return (response.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((thread) => ({
    id: thread.id,
    isResolved: thread.isResolved,
  }));
}

async function listCiChecks(config: RuntimeConfig, headSha: string): Promise<MergerCiCheck[]> {
  const [checkRunsResponse, statusResponse] = await Promise.all([
    githubRequest<GitHubCheckRunsResponse>(config, `/repos/${config.repository}/commits/${headSha}/check-runs?per_page=100`),
    githubRequest<GitHubCombinedStatusResponse>(config, `/repos/${config.repository}/commits/${headSha}/status`),
  ]);

  const checkRuns = (checkRunsResponse.check_runs ?? []).map((checkRun) => ({
    name: checkRun.name,
    status: normalizeCheckStatus(checkRun.status),
    conclusion: checkRun.conclusion,
  } satisfies MergerCiCheck));

  const commitStatuses = (statusResponse.statuses ?? []).map((status) => ({
    name: status.context,
    status: status.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: status.state === 'success' ? 'success' : status.state === 'pending' ? null : 'failure',
  } satisfies MergerCiCheck));

  return dedupeChecks([...checkRuns, ...commitStatuses]);
}

function dedupeChecks(checks: readonly MergerCiCheck[]): MergerCiCheck[] {
  const deduped = new Map<string, MergerCiCheck>();
  for (const check of checks) {
    deduped.set(check.name, check);
  }
  return [...deduped.values()];
}

function normalizeCheckStatus(status: string): MergerCiCheck['status'] {
  if (status === 'queued' || status === 'in_progress' || status === 'completed') {
    return status;
  }

  return 'completed';
}

async function createIssueComment(config: RuntimeConfig, issueNumber: number, body: string): Promise<void> {
  await githubRequest(config, `/repos/${config.repository}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function addIssueLabels(config: RuntimeConfig, issueNumber: number, labels: readonly string[]): Promise<void> {
  if (labels.length === 0) {
    return;
  }

  await githubRequest(config, `/repos/${config.repository}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
}

async function removeIssueLabels(config: RuntimeConfig, issueNumber: number, labels: readonly string[]): Promise<void> {
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

function hasEquivalentMergerComment(
  comments: readonly MergerThreadComment[],
  headSha: string,
  ready: boolean,
  reasons: readonly string[],
): boolean {
  const expectedStatus = ready ? 'ready-to-merge' : 'blocked';
  const expectedReasons = reasons.join(',');

  return comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'merger'
      && metadata?.['head-sha'] === headSha
      && metadata?.status === expectedStatus
      && (metadata?.reasons ?? '') === expectedReasons;
  });
}

async function githubRequest<T = unknown>(config: RuntimeConfig, path: string, init: RequestInit = {}): Promise<T> {
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

async function githubGraphQlRequest<T = unknown>(config: RuntimeConfig, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(config.graphQlUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed (${response.status}): ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;

  if (!repository) {
    throw new Error('Missing required GITHUB_REPOSITORY environment variable.');
  }

  if (!token) {
    throw new Error('Missing required GITHUB_TOKEN environment variable.');
  }

  return {
    repository,
    token,
    apiBaseUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    graphQlUrl: env.GITHUB_GRAPHQL_URL ?? 'https://api.github.com/graphql',
    lookbackHours: parsePositiveInteger(env.MERGER_LOOKBACK_HOURS, 72),
    maxPrs: parsePositiveInteger(env.MERGER_MAX_PRS, 10),
    leaseTtlMinutes: parsePositiveInteger(env.REVIEWER_LEASE_TTL_MINUTES, 45),
    agentId: env.MERGER_AGENT_ID ?? 'merger',
    runId: env.GITHUB_RUN_ID ? `github-actions-${env.GITHUB_RUN_ID}` : `manual-${Date.now()}`,
    now: env.MERGER_NOW ?? new Date().toISOString(),
  };
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

function splitRepository(repository: string): readonly [string, string] {
  const [owner, repo, ...rest] = repository.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  return [owner, repo] as const;
}

function toIsoHoursAgo(now: string, hours: number): string {
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error(`Invalid MERGER_NOW timestamp: ${now}`);
  }

  return new Date(nowDate.getTime() - hours * 60 * 60 * 1000).toISOString();
}
