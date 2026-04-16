import { describe, expect, it } from 'vitest';
import {
  buildCodexInvocationPlan,
  buildMalformedCodexResult,
  parseCodexResult,
  parseImplementorTaskPayload,
  type ImplementorTaskPayload,
} from './implementor-codex.js';
import { selectLatestTrustedPlannerArtifact, type ImplementorIssueComment } from './implementor-runner.js';
import { serializePlannerArtifact } from './planner-artifact.js';

const strictTrustConfig = {
  allowUnsigned: false,
  signing: {
    key: 'signing-secret',
    keyId: 'primary',
  },
} as const;

function buildPlannerArtifact() {
  return {
    kind: 'review-follow-up' as const,
    threadId: 'thread-1',
    sourceCommentId: 'comment-2',
    headSha: 'abc123',
    fixSummary: 'Cover fallback path',
    implementationSteps: ['Update fallback handling.'],
    testSteps: ['Add fallback regression coverage.'],
    verificationSteps: ['Run targeted automation tests.'],
  };
}

function buildSignedPlannerArtifact(): string {
  return serializePlannerArtifact(buildPlannerArtifact(), {
    signing: strictTrustConfig.signing,
  });
}

function buildTaskPayload(overrides: Partial<ImplementorTaskPayload> = {}): ImplementorTaskPayload {
  return {
    repository: 'davidruzicka/mcp4openapi',
    issue: {
      number: 163,
      title: 'Harden SSRFValidator with an explicit HTTP(S) scheme allowlist',
      body: 'Reject non-HTTP schemes before hostname validation and add targeted tests.',
      url: 'https://github.com/davidruzicka/mcp4openapi/issues/163',
      updatedAt: '2026-03-14T23:55:00Z',
      labels: ['agent:safe', 'agent:planned'],
      isPullRequest: false,
    },
    runId: 'github-actions-12345',
    agentId: 'implementor',
    now: '2026-03-15T00:00:00Z',
    ...overrides,
  };
}

function buildComment(body: string, overrides: Partial<ImplementorIssueComment> = {}): ImplementorIssueComment {
  return {
    id: 1,
    body,
    createdAt: '2026-03-14T12:00:00Z',
    updatedAt: '2026-03-14T12:00:00Z',
    authorLogin: 'github-actions[bot]',
    ...overrides,
  };
}

describe('implementor-codex', () => {
  describe('parseImplementorTaskPayload', () => {
    it('parses the JSON payload required by the implementor wrapper', () => {
      expect(parseImplementorTaskPayload(JSON.stringify(buildTaskPayload()), {
        trustConfig: strictTrustConfig,
      })).toMatchObject({
        ...buildTaskPayload(),
        reviewFollowUpItems: [],
        plannerArtifact: undefined,
      });
    });

    it('rejects missing payloads', () => {
      expect(() => parseImplementorTaskPayload(undefined, {
        trustConfig: strictTrustConfig,
      })).toThrow('Missing IMPLEMENTOR_TASK_JSON');
    });

    it('rejects malformed payloads and fills optional issue fields with safe defaults', () => {
      expect(() => parseImplementorTaskPayload('{"repository":"repo"}', {
        trustConfig: strictTrustConfig,
      })).toThrow('Invalid IMPLEMENTOR_TASK_JSON payload');

      expect(parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 163,
          title: 'Scoped fix',
          body: 'Add a targeted regression test.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/163',
        },
        runId: 'run-1',
        agentId: 'implementor',
        now: '2026-03-15T00:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toMatchObject({
        issue: {
          updatedAt: '',
          labels: [],
          isPullRequest: false,
        },
      });
    });

    it('forwards trusted parsing errors with Codex-specific wording', () => {
      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 163,
          title: 'Scoped fix',
          body: 'Add a targeted regression test.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/163',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: serializePlannerArtifact(buildPlannerArtifact()),
        runId: 'run-1',
        agentId: 'implementor',
        now: '2026-03-15T00:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toThrow('Codex implementor backend');
      expect(() => parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 163,
          title: 'Scoped fix',
          body: 'Add a targeted regression test.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/163',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: buildSignedPlannerArtifact().replace('Cover fallback path', 'Tampered summary'),
        runId: 'run-1',
        agentId: 'implementor',
        now: '2026-03-15T00:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toThrow('signature verification failed');
    });

    it('accepts already-selected trusted planner artifacts in strict Codex mode', () => {
      const selectedArtifact = selectLatestTrustedPlannerArtifact([
        buildComment([
          '🤖 Agent plan (planner)',
          '',
          buildSignedPlannerArtifact(),
          '',
          '<!-- AGENT-METADATA',
          'agent-stage: planner',
          'status: planned',
          '-->',
        ].join('\n'), {
          id: 2,
          createdAt: '2026-03-14T13:00:00Z',
          updatedAt: '2026-03-14T13:00:00Z',
        }),
      ], strictTrustConfig);

      expect(selectedArtifact).toBeDefined();
      expect(parseImplementorTaskPayload(JSON.stringify({
        repository: 'davidruzicka/mcp4openapi',
        issue: {
          number: 163,
          title: 'Scoped fix',
          body: 'Add a targeted regression test.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/163',
        },
        reviewFollowUpItems: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add a regression test for the fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        plannerArtifact: selectedArtifact,
        runId: 'run-1',
        agentId: 'implementor',
        now: '2026-03-15T00:00:00Z',
      }), {
        trustConfig: strictTrustConfig,
      })).toMatchObject({
        plannerArtifact: selectedArtifact,
      });
    });
  });

  describe('buildCodexInvocationPlan', () => {
    it('builds a full-auto Codex exec invocation with a machine-readable output path', () => {
      const plan = buildCodexInvocationPlan({
        task: buildTaskPayload(),
        outputPath: '/tmp/implementor-result.json',
        env: {},
        defaultCwd: '/workspace/github.com/davidruzicka/mcp4openapi/.worktrees/agent-automation',
      });

      expect(plan.command).toBe('/workspace/github.com/davidruzicka/mcp4openapi/.worktrees/agent-automation/node_modules/.bin/codex');
      expect(plan.args.slice(0, 2)).toEqual(['exec', '--full-auto']);
      expect(plan.cwd).toBe('/workspace/github.com/davidruzicka/mcp4openapi/.worktrees/agent-automation');
      expect(plan.prompt).toContain('Issue #163');
      expect(plan.prompt).toContain('/tmp/implementor-result.json');
      expect(plan.prompt).toContain('Run targeted tests and typecheck before creating the PR');
      expect(plan.prompt).toContain('This PR was created by an automated agent.');
      expect(plan.prompt).toContain('Return only the JSON object in that file - no markdown fences, headings, logs, or prose.');
      expect(plan.prompt).toContain('Include pullRequest if and only if outcome is "pr-created".');
    });

    it('supports binary, mode, model, and cwd overrides via environment variables', () => {
      const plan = buildCodexInvocationPlan({
        task: buildTaskPayload(),
        outputPath: '/tmp/implementor-result.json',
        env: {
          IMPLEMENTOR_CODEX_BIN: '/usr/local/bin/codex',
          IMPLEMENTOR_CODEX_MODE: 'yolo',
          IMPLEMENTOR_CODEX_MODEL: 'gpt-6-codex',
          IMPLEMENTOR_CODEX_CWD: '/tmp/worktree-163',
        },
        defaultCwd: '/workspace/github.com/davidruzicka/mcp4openapi/.worktrees/agent-automation',
      });

      expect(plan.command).toBe('/usr/local/bin/codex');
      expect(plan.args.slice(0, 4)).toEqual(['exec', '--yolo', '--model', 'gpt-6-codex']);
      expect(plan.cwd).toBe('/tmp/worktree-163');
    });

    it('includes trusted planner artifacts and review follow-up items in the Codex prompt when present', () => {
      const artifact = buildPlannerArtifact();
      const plan = buildCodexInvocationPlan({
        task: buildTaskPayload({
          plannerArtifact: artifact,
          reviewFollowUpItems: [{
            threadId: 'thread-1',
            headSha: 'abc123',
            sourceCommentId: 'comment-2',
            summary: 'Add a regression test for the fallback path',
            actionability: 'actionable',
            requiresReply: true,
          }],
        }),
        outputPath: '/tmp/implementor-result.json',
        env: {},
        defaultCwd: '/workspace/github.com/davidruzicka/mcp4openapi/.worktrees/agent-automation',
      });

      expect(plan.prompt).toContain('Planner artifact:');
      expect(plan.prompt).toContain('"fixSummary": "Cover fallback path"');
      expect(plan.prompt).toContain('"sourceCommentId": "comment-2"');
      expect(plan.prompt).toContain('Review follow-up items:');
    });

    it('rejects unsupported Codex modes from the environment', () => {
      expect(() => buildCodexInvocationPlan({
        task: buildTaskPayload(),
        outputPath: '/tmp/implementor-result.json',
        env: {
          IMPLEMENTOR_CODEX_MODE: 'turbo-danger',
        },
        defaultCwd: '/workspace/github.com/davidruzicka/mcp4openapi/.worktrees/agent-automation',
      })).toThrow('Unsupported IMPLEMENTOR_CODEX_MODE: turbo-danger');
    });
  });

  describe('parseCodexResult', () => {
    it('delegates to the implementor command result parser', () => {
      expect(parseCodexResult('{"outcome":"blocked","summary":"Needs human review."}')).toEqual({
        outcome: 'blocked',
        summary: 'Needs human review.',
      });
    });

    it('accepts JSON wrapped in a fenced markdown block', () => {
      expect(parseCodexResult([
        '```json',
        '{"outcome":"blocked","summary":"Needs human review."}',
        '```',
      ].join('\n'))).toEqual({
        outcome: 'blocked',
        summary: 'Needs human review.',
      });
    });

    it('accepts a single JSON object surrounded by extra text', () => {
      expect(parseCodexResult([
        'Finished the run.',
        '{"outcome":"failed","summary":"Tests failed before a safe patch was ready."}',
        'See worktree notes above.',
      ].join('\n'))).toEqual({
        outcome: 'failed',
        summary: 'Tests failed before a safe patch was ready.',
      });
    });

    it('extracts embedded JSON when earlier brace-like text appears inside strings', () => {
      expect(parseCodexResult([
        'Log output: "ignoring {placeholder} before the real payload"',
        '{"outcome":"blocked","summary":"Needs follow-up for braces in strings."}',
      ].join('\n'))).toEqual({
        outcome: 'blocked',
        summary: 'Needs follow-up for braces in strings.',
      });
    });

    it('extracts embedded JSON when earlier string content contains escaped quotes and braces', () => {
      expect(parseCodexResult([
        'Log output: "prefix with escaped quote: \\\" and brace {still-not-json}"',
        '{"outcome":"blocked","summary":"Needs follow-up for escaped content."}',
      ].join('\n'))).toEqual({
        outcome: 'blocked',
        summary: 'Needs follow-up for escaped content.',
      });
    });

    it('ignores backslashes outside strings so windows-style paths do not swallow later payloads', () => {
      expect(parseCodexResult([
        'Log output: C:\\temp\\"quoted {still-not-json}"',
        '{"outcome":"blocked","summary":"Recovered after windows-style path noise."}',
      ].join('\n'))).toEqual({
        outcome: 'blocked',
        summary: 'Recovered after windows-style path noise.',
      });
    });

    it('keeps scanning embedded JSON objects after earlier brace-delimited noise', () => {
      expect(parseCodexResult([
        'Log output: {"unexpected":"diagnostic"}',
        '{"outcome":"blocked","summary":"Recovered the later valid payload."}',
      ].join('\n'))).toEqual({
        outcome: 'blocked',
        summary: 'Recovered the later valid payload.',
      });
    });

    it('surfaces the final schema error when no candidate can be parsed', () => {
      expect(() => parseCodexResult('Finished the run without writing any JSON payload.')).toThrow('Invalid implementor command result: expected JSON object.');
    });

    it('rejects output containing two independently schema-valid JSON objects', () => {
      expect(() => parseCodexResult([
        '{"outcome":"failed","summary":"First valid result."}',
        '{"outcome":"blocked","summary":"Second valid result."}',
      ].join('\n'))).toThrow('Invalid implementor command result: multiple valid JSON candidates found.');
    });
  });

  describe('buildMalformedCodexResult', () => {
    it('returns a concise failed result instead of bubbling raw parser stacks', () => {
      expect(buildMalformedCodexResult('', new Error('Invalid implementor command result: expected JSON object.'))).toEqual({
        outcome: 'failed',
        summary: 'Codex backend returned malformed result (Invalid implementor command result: expected JSON object.). Received empty output.',
      });
    });

    it('includes a sanitized preview of malformed output for debugging', () => {
      expect(buildMalformedCodexResult('```json\n{ not valid json }\n```', new Error('broken payload'))).toEqual({
        outcome: 'failed',
        summary: 'Codex backend returned malformed result (broken payload). Output preview: "{ not valid json }".',
      });
    });

    it('redacts token-like values and truncates long malformed payload previews', () => {
      const longOutput = `Token: sk-super-secret-token-value-1234567890abcdef ${'word '.repeat(40)}{"outcome":"failed"}`;
      const result = buildMalformedCodexResult(longOutput, new Error('broken payload'));

      expect(result.outcome).toBe('failed');
      expect(result.summary).toContain('Codex backend returned malformed result (broken payload). Output preview: "Token: [redacted-secret]');
      expect(result.summary).toContain('…');
      expect(result.summary).not.toContain('sk-super-secret-token-value-1234567890abcdef');
    });
  });
});
