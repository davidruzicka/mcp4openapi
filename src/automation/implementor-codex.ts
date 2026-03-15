import type { ImplementorCommandResult } from './implementor-runner.js';
import { parseImplementorCommandResult } from './implementor-runner.js';

export interface ImplementorTaskPayload {
  readonly repository: string;
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
    readonly updatedAt: string;
    readonly labels: readonly string[];
    readonly isPullRequest: boolean;
  };
  readonly runId: string;
  readonly agentId: string;
  readonly now: string;
}

export interface BuildCodexInvocationPlanInput {
  readonly task: ImplementorTaskPayload;
  readonly outputPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly defaultCwd: string;
}

export interface CodexInvocationPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly prompt: string;
}

const CODEX_MODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  'full-auto': ['--full-auto'],
  yolo: ['--yolo'],
};

export function parseImplementorTaskPayload(raw: string | undefined): ImplementorTaskPayload {
  if (!raw) {
    throw new Error('Missing IMPLEMENTOR_TASK_JSON payload for Codex implementor backend.');
  }

  const parsed = JSON.parse(raw) as Partial<ImplementorTaskPayload>;
  if (
    typeof parsed.repository !== 'string'
    || !parsed.issue
    || typeof parsed.issue.number !== 'number'
    || typeof parsed.issue.title !== 'string'
    || typeof parsed.issue.body !== 'string'
    || typeof parsed.issue.url !== 'string'
    || typeof parsed.runId !== 'string'
    || typeof parsed.agentId !== 'string'
    || typeof parsed.now !== 'string'
  ) {
    throw new Error('Invalid IMPLEMENTOR_TASK_JSON payload for Codex implementor backend.');
  }

  return {
    repository: parsed.repository,
    issue: {
      number: parsed.issue.number,
      title: parsed.issue.title,
      body: parsed.issue.body,
      url: parsed.issue.url,
      updatedAt: parsed.issue.updatedAt ?? '',
      labels: parsed.issue.labels ?? [],
      isPullRequest: parsed.issue.isPullRequest ?? false,
    },
    runId: parsed.runId,
    agentId: parsed.agentId,
    now: parsed.now,
  };
}

export function buildCodexInvocationPlan(input: BuildCodexInvocationPlanInput): CodexInvocationPlan {
  const command = input.env.IMPLEMENTOR_CODEX_BIN?.trim() || 'codex';
  const mode = normalizeCodexMode(input.env.IMPLEMENTOR_CODEX_MODE);
  const cwd = input.env.IMPLEMENTOR_CODEX_CWD?.trim() || input.defaultCwd;
  const model = input.env.IMPLEMENTOR_CODEX_MODEL?.trim();
  const prompt = buildCodexImplementorPrompt({
    task: input.task,
    outputPath: input.outputPath,
  });

  const args = [
    'exec',
    ...CODEX_MODE_FLAGS[mode],
    ...(model ? ['--model', model] : []),
    prompt,
  ];

  return {
    command,
    args,
    cwd,
    prompt,
  };
}

export function parseCodexResult(raw: string): ImplementorCommandResult {
  return parseImplementorCommandResult(raw);
}

function buildCodexImplementorPrompt(input: {
  readonly task: ImplementorTaskPayload;
  readonly outputPath: string;
}): string {
  const { task } = input;

  return [
    'You are the Codex implementor backend for the mcp4openapi autonomous issue pipeline.',
    'Work only inside the current git repository/worktree and keep the change narrowly scoped to the issue below.',
    'Use senior-level code quality: modular design, clean code, explicit boundaries, data-oriented logic where reasonable, no duplication, and safe defaults.',
    'Use strict TDD: add or update tests first, confirm the relevant tests fail, implement the minimal change, then rerun targeted tests and typecheck.',
    'Run targeted tests and typecheck before creating the PR.',
    'Use English for code comments, commit messages, PR title/body, and notes.',
    'Create a dedicated branch if needed, commit with a Conventional Commits message, push it, and open a PR linked to the issue.',
    'The PR description must clearly disclose automation with this exact sentence: "This PR was created by an automated agent."',
    'The PR body should also mention the agent role, source issue number, workflow run ID, testing performed, and any assumptions or limits.',
    'If you cannot complete the task safely, do not open a PR. Return outcome "blocked" for policy/scope blockers or "failed" for implementation/tooling failures.',
    '',
    `Repository: ${task.repository}`,
    `Agent ID: ${task.agentId}`,
    `Workflow run ID: ${task.runId}`,
    `Timestamp: ${task.now}`,
    `Issue #${task.issue.number}: ${task.issue.title}`,
    `Issue URL: ${task.issue.url}`,
    `Issue labels: ${task.issue.labels.join(', ') || '(none)'}`,
    '',
    'Issue body:',
    task.issue.body || '(empty)',
    '',
    'Required final output:',
    `- Write exactly one JSON object to ${input.outputPath}`,
    '- The JSON must match this schema:',
    '{',
    '  "outcome": "pr-created" | "failed" | "blocked",',
    '  "summary": "short human-readable summary",',
    '  "pullRequest": { "number": 123, "url": "https://github.com/owner/repo/pull/123" }',
    '}',
    '- Include pullRequest only when outcome is "pr-created".',
    '- Do not wrap the JSON in markdown.',
    '- Ensure the file contents are valid JSON before exiting.',
  ].join('\n');
}

function normalizeCodexMode(rawMode: string | undefined): keyof typeof CODEX_MODE_FLAGS {
  const mode = rawMode?.trim() || 'full-auto';
  if (mode in CODEX_MODE_FLAGS) {
    return mode as keyof typeof CODEX_MODE_FLAGS;
  }

  throw new Error(`Unsupported IMPLEMENTOR_CODEX_MODE: ${mode}`);
}
