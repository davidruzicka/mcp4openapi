import {
  buildSemanticReviewerDecision,
  collectReviewerAssignments,
  type ReviewerChangedFile,
  type ReviewerPullRequest,
  type ReviewerReviewArtifact,
  type ReviewerReviewThread,
  type ReviewerThreadComment,
} from '../src/automation/reviewer-runner.js';

interface GitHubLabel {
  readonly name: string;
}

interface GitHubPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
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

interface GraphQlReviewThreadsResponse {
  readonly data?: {
    readonly repository?: {
      readonly pullRequest?: {
        readonly reviewThreads?: {
          readonly nodes?: ReadonlyArray<{
            readonly id: string;
            readonly isResolved: boolean;
            readonly comments?: {
              readonly nodes?: ReadonlyArray<{
                readonly id: string;
                readonly body: string;
                readonly updatedAt: string;
                readonly author?: { readonly login?: string };
              }>;
            };
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
  readonly lookbackHours: number;
  readonly maxPrs: number;
  readonly leaseTtlMinutes: number;
  readonly agentId: string;
  readonly runId: string;
  readonly now: string;
}

interface GitHubPullRequestFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed' | 'renamed' | string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string;
}

interface CreateReviewInput {
  readonly body: string;
  readonly event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
}

const runtimeConfig = readRuntimeConfig(process.env);
const recentPullRequests = await listRecentPullRequests(runtimeConfig);
const commentsByPrNumber: Record<number, readonly ReviewerThreadComment[]> = {};
const reviewsByPrNumber: Record<number, readonly ReviewerReviewArtifact[]> = {};
const reviewThreadsByPrNumber: Record<number, readonly ReviewerReviewThread[]> = {};

for (const pullRequest of recentPullRequests) {
  commentsByPrNumber[pullRequest.number] = await listIssueComments(runtimeConfig, pullRequest.number);
  reviewsByPrNumber[pullRequest.number] = await listPullRequestReviews(runtimeConfig, pullRequest.number);
  reviewThreadsByPrNumber[pullRequest.number] = await listReviewThreads(runtimeConfig, pullRequest.number);
}

const assignments = collectReviewerAssignments({
  pullRequests: recentPullRequests,
  commentsByPrNumber,
  reviewsByPrNumber,
  reviewThreadsByPrNumber,
  repository: runtimeConfig.repository,
  agentId: runtimeConfig.agentId,
  runId: runtimeConfig.runId,
  now: runtimeConfig.now,
  leaseTtlMinutes: runtimeConfig.leaseTtlMinutes,
});

for (const assignment of assignments.slice(0, runtimeConfig.maxPrs)) {
  const pullRequest = recentPullRequests.find((candidate) => candidate.number === assignment.pullRequestNumber);
  if (!pullRequest) {
    throw new Error(`Missing PR snapshot for reviewer assignment #${assignment.pullRequestNumber}.`);
  }

  await addIssueLabels(runtimeConfig, assignment.pullRequestNumber, ['agent:review:in-progress']);
  await createIssueComment(runtimeConfig, assignment.pullRequestNumber, assignment.leaseCommentBody);

  const changedFiles = await listPullRequestFiles(runtimeConfig, assignment.pullRequestNumber);
  const decision = buildSemanticReviewerDecision({
    repository: runtimeConfig.repository,
    agentId: runtimeConfig.agentId,
    runId: runtimeConfig.runId,
    timestamp: runtimeConfig.now,
    pullRequest,
    changedFiles,
  });

  await createPullRequestReview(runtimeConfig, assignment.pullRequestNumber, {
    event: toGitHubReviewEvent(decision.verdict),
    body: decision.reviewBody,
  });
  await addIssueLabels(runtimeConfig, assignment.pullRequestNumber, decision.labelsToAdd);
  await removeIssueLabels(runtimeConfig, assignment.pullRequestNumber, decision.labelsToRemove);

  process.stdout.write(`Reviewed PR #${assignment.pullRequestNumber} (${decision.verdict}; ${assignment.reason}).\n`);
}

process.stdout.write(`Reviewer runner completed. Processed ${Math.min(assignments.length, runtimeConfig.maxPrs)} PR(s).\n`);

async function listRecentPullRequests(config: RuntimeConfig): Promise<ReviewerPullRequest[]> {
  const updatedSince = toIsoHoursAgo(config.now, config.lookbackHours);
  const pullRequests = await githubRequest<GitHubPullRequestSummary[]>(config, `/repos/${config.repository}/pulls?state=open&sort=updated&direction=desc&per_page=100`);

  return pullRequests
    .filter((pullRequest) => pullRequest.updated_at >= updatedSince)
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? '',
      url: pullRequest.html_url,
      draft: pullRequest.draft,
      headSha: pullRequest.head.sha,
      updatedAt: pullRequest.updated_at,
      labels: (pullRequest.labels ?? []).map((label) => label.name),
    } satisfies ReviewerPullRequest));
}

async function listIssueComments(config: RuntimeConfig, issueNumber: number): Promise<ReviewerThreadComment[]> {
  const comments = await githubRequest<GitHubIssueComment[]>(config, `/repos/${config.repository}/issues/${issueNumber}/comments?per_page=100`);
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body ?? '',
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    authorLogin: comment.user?.login ?? 'unknown',
  }));
}

async function listPullRequestReviews(config: RuntimeConfig, pullRequestNumber: number): Promise<ReviewerReviewArtifact[]> {
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

async function listPullRequestFiles(config: RuntimeConfig, pullRequestNumber: number): Promise<ReviewerChangedFile[]> {
  const files = await githubRequest<GitHubPullRequestFile[]>(config, `/repos/${config.repository}/pulls/${pullRequestNumber}/files?per_page=100`);
  return files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch,
  }));
}

async function listReviewThreads(config: RuntimeConfig, pullRequestNumber: number): Promise<ReviewerReviewThread[]> {
  const [owner, repo] = splitRepository(config.repository);
  const response = await githubGraphQlRequest<GraphQlReviewThreadsResponse>(config, {
    query: `query ReviewThreads($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 100) {
                nodes {
                  id
                  body
                  updatedAt
                  author {
                    login
                  }
                }
              }
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
    comments: (thread.comments?.nodes ?? []).map((comment) => ({
      id: comment.id,
      body: comment.body,
      updatedAt: comment.updatedAt,
      authorLogin: comment.author?.login ?? 'unknown',
    })),
  }));
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

async function createPullRequestReview(config: RuntimeConfig, pullRequestNumber: number, input: CreateReviewInput): Promise<void> {
  await githubRequest(config, `/repos/${config.repository}/pulls/${pullRequestNumber}/reviews`, {
    method: 'POST',
    body: JSON.stringify(input),
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
  const response = await fetch(`${config.apiBaseUrl.replace(/\/api\/v3$/, '')}/graphql`, {
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
    lookbackHours: parsePositiveInteger(env.REVIEWER_LOOKBACK_HOURS, 72),
    maxPrs: parsePositiveInteger(env.REVIEWER_MAX_PRS, 10),
    leaseTtlMinutes: parsePositiveInteger(env.REVIEWER_LEASE_TTL_MINUTES, 45),
    agentId: env.REVIEWER_AGENT_ID ?? 'reviewer',
    runId: env.GITHUB_RUN_ID ? `github-actions-${env.GITHUB_RUN_ID}` : `manual-${Date.now()}`,
    now: env.REVIEWER_NOW ?? new Date().toISOString(),
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

function toGitHubReviewEvent(verdict: 'approved' | 'changes-requested' | 'commented'): CreateReviewInput['event'] {
  switch (verdict) {
    case 'approved':
      return 'APPROVE';
    case 'changes-requested':
      return 'REQUEST_CHANGES';
    case 'commented':
      return 'COMMENT';
  }
}

function toIsoHoursAgo(now: string, hours: number): string {
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error(`Invalid REVIEWER_NOW timestamp: ${now}`);
  }

  const sinceDate = new Date(nowDate.getTime() - hours * 60 * 60 * 1000);
  return sinceDate.toISOString();
}
