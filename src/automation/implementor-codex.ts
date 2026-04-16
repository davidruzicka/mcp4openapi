import { join } from 'node:path';
import type {
  ImplementorCommandResult,
  ImplementorTaskPayload,
  ParseImplementorTaskPayloadOptions,
} from './implementor-runner.js';
import {
  parseImplementorCommandResult,
  parseImplementorTaskPayload as parseImplementorWorkflowTaskPayload,
} from './implementor-runner.js';

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

export function parseImplementorTaskPayload(
  raw: string | undefined,
  options?: ParseImplementorTaskPayloadOptions,
): ImplementorTaskPayload {
  try {
    return parseImplementorWorkflowTaskPayload(raw, options);
  } catch (error) {
    // Normalize every parse failure at the backend boundary so callers always receive
    // a deterministic Error instance instead of arbitrary thrown payloads.
    const detail = error instanceof Error ? error.message : 'unknown parse failure';
    throw new Error(`Codex implementor backend: ${detail}`);
  }
}

export function buildCodexInvocationPlan(input: BuildCodexInvocationPlanInput): CodexInvocationPlan {
  const command = input.env.IMPLEMENTOR_CODEX_BIN?.trim() || join(input.defaultCwd, 'node_modules/.bin/codex');
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
  const candidates = collectCodexResultCandidates(raw);
  const valid: ImplementorCommandResult[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      valid.push(parseImplementorCommandResult(candidate));
    } catch (error) {
      lastError = error;
    }
  }

  if (valid.length === 1) return valid[0];
  if (valid.length > 1) throw new Error('Invalid implementor command result: multiple valid JSON candidates found.');
  throw lastError instanceof Error ? lastError : new Error('Invalid implementor command result: expected JSON object.');
}

export function buildMalformedCodexResult(raw: string, error: unknown): ImplementorCommandResult {
  const detail = error instanceof Error ? error.message : 'Invalid Codex result payload.';
  const preview = summarizeMalformedCodexOutput(raw);
  return {
    outcome: 'failed',
    summary: preview
      ? `Codex backend returned malformed result (${detail}). ${preview}`
      : `Codex backend returned malformed result (${detail}).`,
  };
}

function summarizeMalformedCodexOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return 'Received empty output.';
  }

  const unfenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i)?.[1]?.trim() ?? trimmed;
  const collapsedWhitespace = unfenced.replace(/\s+/g, ' ').trim();
  const redactedSecrets = collapsedWhitespace
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(?:sk|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted-secret]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, '[redacted-secret]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted-secret]');

  const preview = redactedSecrets.length > 160
    ? `${redactedSecrets.slice(0, 159)}…`
    : redactedSecrets;

  return `Output preview: ${JSON.stringify(preview)}.`;
}

function collectCodexResultCandidates(raw: string): string[] {
  const candidates = new Set<string>();
  const trimmed = raw.trim();

  if (trimmed.length > 0) {
    candidates.add(trimmed);
  }

  const fencedJson = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fencedJson) {
    candidates.add(fencedJson);
  }

  for (const embeddedJsonObject of extractEmbeddedJsonObjects(trimmed)) {
    candidates.add(embeddedJsonObject);
  }

  return [...candidates];
}

function extractEmbeddedJsonObjects(raw: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string;

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaping = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(raw.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
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
    ...(task.plannerArtifact ? [
      '',
      'Planner artifact:',
      JSON.stringify(task.plannerArtifact, null, 2),
    ] : []),
    ...(task.reviewFollowUpItems && task.reviewFollowUpItems.length > 0 ? [
      '',
      'Review follow-up items:',
      JSON.stringify(task.reviewFollowUpItems, null, 2),
    ] : []),
    '',
    'Required final output:',
    `- Write exactly one JSON object to ${input.outputPath}`,
    '- Return only the JSON object in that file - no markdown fences, headings, logs, or prose.',
    '- The JSON must match this schema exactly:',
    '{',
    '  "outcome": "pr-created" | "failed" | "blocked",',
    '  "summary": "short human-readable summary",',
    '  "pullRequest": { "number": 123, "url": "https://github.com/owner/repo/pull/123" }',
    '}',
    '- Include pullRequest if and only if outcome is "pr-created".',
    '- Always include outcome and summary.',
    '- If you cannot complete the task, still write a schema-valid object with outcome "failed" or "blocked" and a concrete summary.',
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
