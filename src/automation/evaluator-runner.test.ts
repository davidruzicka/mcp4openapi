import { describe, expect, it } from 'vitest';
import {
  collectEvaluatorFollowUpRequests,
  parseAgentMetadata,
  resolveStageFromMetadata,
  selectVerdictFromReactions,
  type EvaluatorTargetArtifact,
  type IssueThreadComment,
} from './evaluator-runner.js';

describe('evaluator-runner', () => {
  describe('parseAgentMetadata', () => {
    it('extracts metadata entries from an AGENT-METADATA block', () => {
      expect(parseAgentMetadata([
        'Intro text',
        '<!-- AGENT-METADATA',
        'agent-id: reviewer-quality',
        'agent-stage: reviewer',
        'head-sha: abc123',
        '-->',
      ].join('\n'))).toEqual({
        'agent-id': 'reviewer-quality',
        'agent-stage': 'reviewer',
        'head-sha': 'abc123',
      });
    });

    it('ignores malformed metadata blocks without valid key-value pairs', () => {
      expect(parseAgentMetadata('No metadata here')).toBeUndefined();
      expect(parseAgentMetadata(['<!-- AGENT-METADATA', 'broken-line', '-->'].join('\n'))).toBeUndefined();
      expect(parseAgentMetadata(['<!-- AGENT-METADATA', 'agent-id:', '-->'].join('\n'))).toBeUndefined();
    });
  });

  describe('resolveStageFromMetadata', () => {
    it('prefers an explicit agent-stage field', () => {
      expect(resolveStageFromMetadata({
        'agent-id': 'reviewer-quality',
        'agent-stage': 'reviewer',
        'agent-role': 'review',
      })).toBe('reviewer');
    });

    it('falls back to role/name inference for legacy metadata', () => {
      expect(resolveStageFromMetadata({
        'agent-id': 'implementor',
        'agent-role': 'implementation',
      })).toBe('implementor');
    });
  });

  describe('selectVerdictFromReactions', () => {
    it('returns negative for thumbs-down only signals', () => {
      expect(selectVerdictFromReactions({
        '+1': 0,
        '-1': 2,
      })).toBe('negative');
    });

    it('returns undefined for mixed positive and negative reactions', () => {
      expect(selectVerdictFromReactions({
        '+1': 1,
        '-1': 1,
      })).toBeUndefined();
    });

    it('returns positive for thumbs-up only signals', () => {
      expect(selectVerdictFromReactions({
        '+1': 2,
        '-1': 0,
      })).toBe('positive');
    });
  });

  describe('collectEvaluatorFollowUpRequests', () => {
    it('creates a follow-up request for thumbs-only negative feedback on an agent comment', () => {
      const targetArtifacts: EvaluatorTargetArtifact[] = [
        {
          id: 501,
          issueNumber: 155,
          prNumber: 156,
          targetType: 'comment',
          agentId: 'reviewer-quality',
          stage: 'reviewer',
          body: 'LGTM\n<!-- AGENT-METADATA\nagent-id: reviewer-quality\nagent-stage: reviewer\nhead-sha: abc123\n-->',
          url: 'https://github.com/davidruzicka/mcp4openapi/pull/156#issuecomment-501',
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:01:00Z',
          reactions: {
            '+1': 0,
            '-1': 1,
          },
        },
      ];
      const threadComments: IssueThreadComment[] = [];

      expect(collectEvaluatorFollowUpRequests({
        targetArtifacts,
        threadComments,
        repository: 'davidruzicka/mcp4openapi',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
      })).toEqual([
        expect.objectContaining({
          issueNumber: 155,
          commentBody: expect.stringContaining('missed-defect'),
        }),
      ]);
    });

    it('does not duplicate an existing evaluator follow-up for the same target', () => {
      const targetArtifacts: EvaluatorTargetArtifact[] = [
        {
          id: 501,
          issueNumber: 155,
          prNumber: 156,
          targetType: 'comment',
          agentId: 'reviewer-quality',
          stage: 'reviewer',
          body: 'LGTM\n<!-- AGENT-METADATA\nagent-id: reviewer-quality\nagent-stage: reviewer\n-->',
          url: 'https://github.com/davidruzicka/mcp4openapi/pull/156#issuecomment-501',
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:01:00Z',
          reactions: {
            '+1': 0,
            '-1': 1,
          },
        },
      ];
      const threadComments: IssueThreadComment[] = [
        {
          id: 900,
          issueNumber: 155,
          body: [
            'Thanks for the feedback.',
            '<!-- AGENT-METADATA',
            'agent-id: evaluator',
            'target-type: comment',
            'target-number: 501',
            'status: awaiting-human-feedback',
            '-->',
          ].join('\n'),
          createdAt: '2026-03-14T16:05:00Z',
          updatedAt: '2026-03-14T16:05:00Z',
          authorLogin: 'github-actions[bot]',
        },
      ];

      expect(collectEvaluatorFollowUpRequests({
        targetArtifacts,
        threadComments,
        repository: 'davidruzicka/mcp4openapi',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
      })).toEqual([]);
    });

    it('ignores evaluator-authored artifacts and workflow-ignored metadata', () => {
      const targetArtifacts: EvaluatorTargetArtifact[] = [
        {
          id: 502,
          issueNumber: 155,
          targetType: 'comment',
          agentId: 'evaluator',
          stage: 'reviewer',
          body: 'Evaluator note\n<!-- AGENT-METADATA\nagent-id: evaluator\nignore-for-workflow: true\n-->',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/155#issuecomment-502',
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:01:00Z',
          reactions: {
            '+1': 0,
            '-1': 1,
          },
        },
        {
          id: 503,
          issueNumber: 155,
          targetType: 'comment',
          agentId: 'reviewer-quality',
          stage: 'reviewer',
          body: 'Ignored by workflow\n<!-- AGENT-METADATA\nagent-id: reviewer-quality\nagent-stage: reviewer\nignore-for-workflow: true\n-->',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/155#issuecomment-503',
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:01:00Z',
          reactions: {
            '+1': 0,
            '-1': 1,
          },
        },
      ];

      expect(collectEvaluatorFollowUpRequests({
        targetArtifacts,
        threadComments: [],
        repository: 'davidruzicka/mcp4openapi',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
      })).toEqual([]);
    });

    it('generates a pull_request target for PR bodies', () => {
      const targetArtifacts: EvaluatorTargetArtifact[] = [
        {
          id: 156,
          issueNumber: 156,
          prNumber: 156,
          targetType: 'pull_request',
          agentId: 'implementor',
          stage: 'implementor',
          body: 'PR body\n<!-- AGENT-METADATA\nagent-id: implementor\nagent-stage: implementor\n-->',
          url: 'https://github.com/davidruzicka/mcp4openapi/pull/156',
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:01:00Z',
          reactions: {
            '+1': 1,
            '-1': 0,
          },
        },
      ];

      const [request] = collectEvaluatorFollowUpRequests({
        targetArtifacts,
        threadComments: [],
        repository: 'davidruzicka/mcp4openapi',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
      });

      expect(request).toEqual(expect.objectContaining({
        issueNumber: 156,
        targetType: 'pull_request',
        targetNumber: 156,
      }));
      expect(request.commentBody).toContain('clean-implementation');
    });

    it('skips artifacts without a clear verdict and stages that do not request extra detail', () => {
      const targetArtifacts: EvaluatorTargetArtifact[] = [
        {
          id: 157,
          issueNumber: 157,
          targetType: 'comment',
          agentId: 'reviewer-quality',
          stage: 'reviewer',
          body: 'No strong reaction yet',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/157#issuecomment-157',
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:01:00Z',
          reactions: {},
        },
        {
          id: 158,
          issueNumber: 158,
          targetType: 'pull_request',
          agentId: 'merger-bot',
          stage: 'merger',
          body: 'Merge completed safely',
          url: 'https://github.com/davidruzicka/mcp4openapi/pull/158',
          createdAt: '2026-03-14T16:00:00Z',
          updatedAt: '2026-03-14T16:01:00Z',
          reactions: {
            '+1': 1,
            '-1': 0,
          },
        },
      ];

      expect(collectEvaluatorFollowUpRequests({
        targetArtifacts,
        threadComments: [],
        repository: 'davidruzicka/mcp4openapi',
        runId: 'run-123',
        now: '2026-03-14T16:10:00Z',
      })).toEqual([]);
    });
  });
});
