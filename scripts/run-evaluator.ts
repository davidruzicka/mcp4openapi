import {
  collectEvaluatorFollowUpRequests,
  parseAgentMetadata,
  resolveStageFromMetadata,
  type EvaluatorTargetArtifact,
  type IssueThreadComment,
  type ReactionSummary,
} from '../src/automation/evaluator-runner.js';

interface GitHubIssueSummary {
  readonly number: number;
  readonly body: string | null;
  readonly html_url: string;
  readonly updated_at: string;
  readonly created_at: string;
  readonly pull_request?: Record<string, unknown>;
  readonly reactions?: ReactionSummary;
}

interface GitHubIssueComment {
  readonly id: number;
  readonly body: string | null;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly user?: {
    readonly login?: string;
  };
  readonly reactions?: ReactionSummary;
}

interface RuntimeConfig {
  readonly repository: string;
  readonly token: string;
  readonly apiBaseUrl: string;
  readonly lookbackHours: number;
  readonly maxIssues: number;
  readonly maxPosts: number;
  readonly runId: string;
  readonly now: string;
}

const runtimeConfig = readRuntimeConfig(process.env);
const recentIssues = await listRecentIssues(runtimeConfig);
let createdComments = 0;

for (const issue of recentIssues) {
  if (createdComments >= runtimeConfig.maxPosts) {
    break;
  }

  const issueComments = await listIssueComments(runtimeConfig, issue.number);
  const targetArtifacts = buildTargetArtifacts(issue, issueComments);
  const followUpRequests = collectEvaluatorFollowUpRequests({
    targetArtifacts,
    threadComments: issueComments.map((comment) => ({
      id: comment.id,
      issueNumber: issue.number,
      body: comment.body ?? '',
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
      authorLogin: comment.user?.login ?? 'unknown',
    } satisfies IssueThreadComment)),
    repository: runtimeConfig.repository,
    runId: runtimeConfig.runId,
    now: runtimeConfig.now,
  });

  for (const request of followUpRequests) {
    if (createdComments >= runtimeConfig.maxPosts) {
      break;
    }

    await createIssueComment(runtimeConfig, request.issueNumber, request.commentBody);
    createdComments += 1;
    process.stdout.write(`Created evaluator follow-up on #${request.issueNumber} for ${request.targetType}:${request.targetNumber}\n`);
  }
}

process.stdout.write(`Evaluator runner completed. Created ${createdComments} follow-up comment(s).\n`);

async function listRecentIssues(config: RuntimeConfig): Promise<GitHubIssueSummary[]> {
  const updatedSince = toIsoHoursAgo(config.now, config.lookbackHours);
  const issues = await githubRequest<GitHubIssueSummary[]>(config, `/repos/${config.repository}/issues?state=all&sort=updated&direction=desc&per_page=${config.maxIssues}&since=${encodeURIComponent(updatedSince)}`);
  return issues.filter((issue) => issue.updated_at >= updatedSince);
}

async function listIssueComments(config: RuntimeConfig, issueNumber: number): Promise<GitHubIssueComment[]> {
  return githubRequest<GitHubIssueComment[]>(config, `/repos/${config.repository}/issues/${issueNumber}/comments?per_page=100`);
}

async function createIssueComment(config: RuntimeConfig, issueNumber: number, body: string): Promise<void> {
  await githubRequest(config, `/repos/${config.repository}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

function buildTargetArtifacts(issue: GitHubIssueSummary, issueComments: readonly GitHubIssueComment[]): EvaluatorTargetArtifact[] {
  const issueTarget = buildIssueBodyArtifact(issue);
  const commentTargets = issueComments
    .map((comment) => buildIssueCommentArtifact(issue, comment))
    .filter((artifact): artifact is EvaluatorTargetArtifact => artifact !== undefined);

  return [issueTarget, ...commentTargets].filter((artifact): artifact is EvaluatorTargetArtifact => artifact !== undefined);
}

function buildIssueBodyArtifact(issue: GitHubIssueSummary): EvaluatorTargetArtifact | undefined {
  const metadata = parseAgentMetadata(issue.body ?? '');
  if (!metadata) {
    return undefined;
  }

  const stage = resolveStageFromMetadata(metadata);
  const agentId = metadata['agent-id'];
  if (!stage || !agentId) {
    return undefined;
  }

  return {
    id: issue.number,
    issueNumber: issue.number,
    prNumber: issue.pull_request ? issue.number : undefined,
    targetType: issue.pull_request ? 'pull_request' : 'issue',
    agentId,
    stage,
    body: issue.body ?? '',
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    reactions: issue.reactions ?? {},
  };
}

function buildIssueCommentArtifact(issue: GitHubIssueSummary, comment: GitHubIssueComment): EvaluatorTargetArtifact | undefined {
  const body = comment.body ?? '';
  const metadata = parseAgentMetadata(body);
  if (!metadata) {
    return undefined;
  }

  const stage = resolveStageFromMetadata(metadata);
  const agentId = metadata['agent-id'];
  if (!stage || !agentId) {
    return undefined;
  }

  return {
    id: comment.id,
    issueNumber: issue.number,
    prNumber: issue.pull_request ? issue.number : undefined,
    targetType: 'comment',
    agentId,
    stage,
    body,
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    reactions: comment.reactions ?? {},
  };
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
    lookbackHours: parsePositiveInteger(env.EVALUATOR_LOOKBACK_HOURS, 24),
    maxIssues: parsePositiveInteger(env.EVALUATOR_MAX_ISSUES, 30),
    maxPosts: parsePositiveInteger(env.EVALUATOR_MAX_POSTS, 10),
    runId: env.GITHUB_RUN_ID ? `github-actions-${env.GITHUB_RUN_ID}` : `manual-${Date.now()}`,
    now: env.EVALUATOR_NOW ?? new Date().toISOString(),
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

function toIsoHoursAgo(now: string, hours: number): string {
  const nowDate = new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error(`Invalid EVALUATOR_NOW timestamp: ${now}`);
  }

  const sinceDate = new Date(nowDate.getTime() - hours * 60 * 60 * 1000);
  return sinceDate.toISOString();
}
