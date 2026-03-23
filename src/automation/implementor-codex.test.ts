import { describe, expect, it } from 'vitest';
import {
  buildCodexInvocationPlan,
  parseCodexResult,
  parseImplementorTaskPayload,
  type ImplementorTaskPayload,
} from './implementor-codex.js';

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

describe('implementor-codex', () => {
  describe('parseImplementorTaskPayload', () => {
    it('parses the JSON payload required by the implementor wrapper', () => {
      expect(parseImplementorTaskPayload(JSON.stringify(buildTaskPayload()))).toMatchObject({
        ...buildTaskPayload(),
        reviewFollowUpItems: [],
        plannerArtifact: undefined,
      });
    });

    it('rejects missing payloads', () => {
      expect(() => parseImplementorTaskPayload(undefined)).toThrow('Missing IMPLEMENTOR_TASK_JSON');
    });

    it('rejects malformed payloads and fills optional issue fields with safe defaults', () => {
      expect(() => parseImplementorTaskPayload('{"repository":"repo"}')).toThrow('Invalid IMPLEMENTOR_TASK_JSON payload');

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
      }))).toMatchObject({
        issue: {
          updatedAt: '',
          labels: [],
          isPullRequest: false,
        },
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

      expect(plan.command).toBe('codex');
      expect(plan.args.slice(0, 2)).toEqual(['exec', '--full-auto']);
      expect(plan.cwd).toBe('/workspace/github.com/davidruzicka/mcp4openapi/.worktrees/agent-automation');
      expect(plan.prompt).toContain('Issue #163');
      expect(plan.prompt).toContain('/tmp/implementor-result.json');
      expect(plan.prompt).toContain('Run targeted tests and typecheck before creating the PR');
      expect(plan.prompt).toContain('This PR was created by an automated agent.');
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

    it('includes planner artifacts and review follow-up items in the Codex prompt when present', () => {
      const plan = buildCodexInvocationPlan({
        task: buildTaskPayload({
          plannerArtifact: {
            kind: 'review-follow-up',
            threadId: 'thread-1',
            headSha: 'abc123',
            fixSummary: 'Cover fallback path',
            implementationSteps: ['Update fallback handling.'],
            testSteps: ['Add fallback regression coverage.'],
            verificationSteps: ['Run targeted automation tests.'],
          },
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
      expect(plan.prompt).toContain('Review follow-up items:');
      expect(plan.prompt).toContain('"sourceCommentId": "comment-2"');
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
  });
});
