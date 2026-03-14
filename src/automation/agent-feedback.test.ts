import { describe, expect, it } from 'vitest';
import {
  buildAgentMetadataBlock,
  buildEvaluatorFeedbackRequestComment,
  shouldRequestFeedbackDetails,
} from './agent-feedback.js';

describe('agent-feedback', () => {
  describe('shouldRequestFeedbackDetails', () => {
    it('requests follow-up for negative reviewer feedback without a comment', () => {
      expect(shouldRequestFeedbackDetails('reviewer', 'negative')).toBe(true);
    });

    it('does not request follow-up when the human already left a meaningful comment', () => {
      expect(shouldRequestFeedbackDetails('implementor', 'negative', 'Missed regression coverage for auth failure path.')).toBe(false);
    });

    it('requests follow-up for positive reviewer feedback when the signal is otherwise only a thumbs-up', () => {
      expect(shouldRequestFeedbackDetails('reviewer', 'positive')).toBe(true);
    });

    it('does not request follow-up for positive issuer feedback by default', () => {
      expect(shouldRequestFeedbackDetails('issuer', 'positive')).toBe(false);
    });
  });

  describe('buildAgentMetadataBlock', () => {
    it('omits undefined values and preserves deterministic ordering', () => {
      expect(buildAgentMetadataBlock({
        'agent-id': 'evaluator',
        repository: undefined,
        status: 'awaiting-human-feedback',
        'ignore-for-workflow': true,
      })).toBe([
        '<!-- AGENT-METADATA',
        'agent-id: evaluator',
        'status: awaiting-human-feedback',
        'ignore-for-workflow: true',
        '-->',
      ].join('\n'));
    });
  });

  describe('buildEvaluatorFeedbackRequestComment', () => {
    it('builds a reviewer-specific negative follow-up with stale review guidance', () => {
      const comment = buildEvaluatorFeedbackRequestComment({
        stage: 'reviewer',
        verdict: 'negative',
        targetAgentId: 'reviewer-quality',
        targetType: 'review',
        targetNumber: 156,
        reactionSource: 'thumbs_down',
        runId: 'run-123',
        timestamp: '2026-03-14T16:00:00Z',
        repository: 'davidruzicka/mcp4openapi',
        headSha: '8f3c1ab',
        prNumber: 156,
        issueNumber: 155,
        contextSummary: 'Human reacted with thumbs down on the final approval review.',
      });

      expect(comment).toContain('Thanks for the feedback. A short clarification helps improve review prompts and approval gates.');
      expect(comment).toContain('missed-defect (high): reviewer overlooked a correctness, safety, or test gap that should have blocked approval');
      expect(comment).toContain('stale-review-not-detected (high): reviewer treated an older approval as valid after new commits were pushed');
      expect(comment).toContain('Current head SHA: 8f3c1ab');
      expect(comment).toContain('target-agent-id: reviewer-quality');
      expect(comment).toContain('ignore-for-workflow: true');
    });

    it('builds an implementor-specific negative follow-up with scope/test prompts', () => {
      const comment = buildEvaluatorFeedbackRequestComment({
        stage: 'implementor',
        verdict: 'negative',
        targetAgentId: 'implementor',
        targetType: 'pull_request',
        targetNumber: 200,
        reactionSource: 'thumbs_down',
        runId: 'run-456',
        timestamp: '2026-03-14T17:00:00Z',
      });

      expect(comment).toContain('scope-creep (medium): implementation changed more than the issue or plan justified');
      expect(comment).toContain('insufficient-tests (medium): implementation missed needed validation or regression coverage');
      expect(comment).toContain('incorrect-implementation / severity / what happened / expected behavior');
    });
  });
});
