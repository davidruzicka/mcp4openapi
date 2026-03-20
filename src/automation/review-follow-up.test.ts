import { describe, expect, it } from 'vitest';
import {
  buildImplementorThreadReplyPlans,
  collectReviewFollowUpItems,
  type ReviewFollowUpItem,
  type ReviewThreadLike,
} from './review-follow-up.js';

describe('review-follow-up', () => {
  describe('collectReviewFollowUpItems', () => {
    it('extracts one actionable item from a current-head unresolved thread', () => {
      const items = collectReviewFollowUpItems({
        reviewThreads: [buildReviewThread({
          id: 'thread-1',
          isResolved: false,
          comments: [
            buildReviewThreadComment({
              id: 'comment-1',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-19T10:00:00Z',
              body: 'Please add a regression test for the fallback path.',
            }),
          ],
        })],
        currentHeadSha: 'abc123',
      });

      expect(items).toEqual([
        expect.objectContaining({
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-1',
          actionability: 'actionable',
          requiresReply: true,
        }),
      ]);
      expect(items[0]?.summary).toContain('fallback path');
    });

    it('skips stale-head threads when metadata binds them to an older head', () => {
      const items = collectReviewFollowUpItems({
        reviewThreads: [buildReviewThread({
          id: 'thread-1',
          isResolved: false,
          comments: [
            buildReviewThreadComment({
              id: 'comment-1',
              authorLogin: 'github-actions[bot]',
              updatedAt: '2026-03-19T10:00:00Z',
              body: buildAgentComment({
                stage: 'reviewer',
                status: 'commented',
                headSha: 'old-sha',
                timestamp: '2026-03-19T10:00:00Z',
              }),
            }),
            buildReviewThreadComment({
              id: 'comment-2',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-19T10:05:00Z',
              body: 'This belongs to the old revision.',
            }),
          ],
        })],
        currentHeadSha: 'new-sha',
      });

      expect(items).toEqual([]);
    });

    it('skips resolved threads that only contain informational agent metadata', () => {
      const items = collectReviewFollowUpItems({
        reviewThreads: [buildReviewThread({
          id: 'thread-1',
          isResolved: true,
          comments: [
            buildReviewThreadComment({
              id: 'comment-1',
              authorLogin: 'github-actions[bot]',
              updatedAt: '2026-03-19T10:00:00Z',
              body: buildAgentComment({
                stage: 'reviewer',
                status: 'approved',
                headSha: 'abc123',
                timestamp: '2026-03-19T10:00:00Z',
              }),
            }),
          ],
        })],
        currentHeadSha: 'abc123',
      });

      expect(items).toEqual([]);
    });

    it('returns stable output across duplicate reruns over the same thread data', () => {
      const input = {
        reviewThreads: [buildReviewThread({
          id: 'thread-1',
          isResolved: false,
          comments: [buildReviewThreadComment({
            id: 'comment-1',
            authorLogin: 'human-reviewer',
            updatedAt: '2026-03-19T10:00:00Z',
            body: 'Add regression coverage for the error path.',
          })],
        })],
        currentHeadSha: 'abc123',
      };

      expect(collectReviewFollowUpItems(input)).toEqual(collectReviewFollowUpItems(input));
    });
  });

  describe('buildImplementorThreadReplyPlans', () => {
    it('builds one reply plan per actionable follow-up item', () => {
      const replies = buildImplementorThreadReplyPlans({
        items: [{
          threadId: 'thread-1',
          headSha: 'abc123',
          sourceCommentId: 'comment-2',
          summary: 'Add regression coverage for fallback path',
          actionability: 'actionable',
          requiresReply: true,
        }],
        newHeadSha: 'def456',
        resultSummary: 'Added fallback-path regression coverage.',
      });

      expect(replies).toHaveLength(1);
      expect(replies[0]?.body).toContain('This reply was prepared by an agent.');
      expect(replies[0]?.body).toContain('def456');
      expect(replies[0]?.body).toContain('agent-stage: implementor');
    });

    it('fails closed when a reply plan would be missing required thread metadata', () => {
      const brokenItem = {
        threadId: '',
        headSha: 'abc123',
        sourceCommentId: 'comment-2',
        summary: 'Add regression coverage for fallback path',
        actionability: 'actionable',
        requiresReply: true,
      } as ReviewFollowUpItem;

      expect(() => buildImplementorThreadReplyPlans({
        items: [brokenItem],
        newHeadSha: 'def456',
        resultSummary: 'Added fallback-path regression coverage.',
      })).toThrow('Invalid review follow-up item');
    });

    it('deduplicates reply plans for duplicate actionable items on the same thread', () => {
      const item: ReviewFollowUpItem = {
        threadId: 'thread-1',
        headSha: 'abc123',
        sourceCommentId: 'comment-2',
        summary: 'Add regression coverage for fallback path',
        actionability: 'actionable',
        requiresReply: true,
      };

      const replies = buildImplementorThreadReplyPlans({
        items: [item, item],
        newHeadSha: 'def456',
        resultSummary: 'Added fallback-path regression coverage.',
      });

      expect(replies).toHaveLength(1);
    });
  });
});

function buildReviewThread(overrides: Partial<ReviewThreadLike> = {}): ReviewThreadLike {
  return {
    id: 'thread-1',
    isResolved: false,
    comments: [],
    ...overrides,
  };
}

function buildReviewThreadComment(overrides: Partial<ReviewThreadLike['comments'][number]> = {}): ReviewThreadLike['comments'][number] {
  return {
    id: 'comment-1',
    body: 'Thread comment',
    updatedAt: '2026-03-19T10:00:00Z',
    authorLogin: 'github-actions[bot]',
    ...overrides,
  };
}

function buildAgentComment(input: {
  stage: string;
  status: string;
  headSha: string;
  timestamp: string;
}): string {
  return [
    '🤖 Agent note',
    '',
    '<!-- AGENT-METADATA',
    `agent-stage: ${input.stage}`,
    `status: ${input.status}`,
    `head-sha: ${input.headSha}`,
    `timestamp: ${input.timestamp}`,
    '-->',
  ].join('\n');
}
