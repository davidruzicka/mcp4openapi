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

    it('skips unresolved threads that only contain agent metadata and no external review comment', () => {
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

    it('prefers current-head metadata when a thread contains agent comments for multiple heads', () => {
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
              authorLogin: 'github-actions[bot]',
              updatedAt: '2026-03-19T10:01:00Z',
              body: buildAgentComment({
                stage: 'reviewer',
                status: 'commented',
                headSha: 'new-sha',
                timestamp: '2026-03-19T10:01:00Z',
              }),
            }),
            buildReviewThreadComment({
              id: 'comment-3',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-19T10:05:00Z',
              body: 'Please cover the latest revision too.',
            }),
          ],
        })],
        currentHeadSha: 'new-sha',
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        threadId: 'thread-1',
        headSha: 'new-sha',
        sourceCommentId: 'comment-3',
      });
    });

    it('uses the latest external review comment by timestamp when collecting follow-up items', () => {
      const items = collectReviewFollowUpItems({
        reviewThreads: [buildReviewThread({
          comments: [
            buildReviewThreadComment({
              id: 'comment-1',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-19T10:00:00Z',
              body: 'Older request.',
            }),
            buildReviewThreadComment({
              id: 'comment-2',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-19T10:05:00Z',
              body: 'Newest request should be summarized.',
            }),
          ],
        })],
        currentHeadSha: 'abc123',
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        sourceCommentId: 'comment-2',
        summary: 'Newest request should be summarized.',
      });
    });

    it('truncates long review comments in the follow-up summary', () => {
      const longComment = `${'Need more regression coverage on the fallback path. '.repeat(5)}Also validate telemetry.`;

      const items = collectReviewFollowUpItems({
        reviewThreads: [buildReviewThread({
          comments: [buildReviewThreadComment({
            id: 'comment-1',
            authorLogin: 'human-reviewer',
            updatedAt: '2026-03-19T10:00:00Z',
            body: longComment,
          })],
        })],
        currentHeadSha: 'abc123',
      });

      expect(items).toHaveLength(1);
      expect(items[0]?.summary).toHaveLength(160);
      expect(items[0]?.summary.endsWith('...')).toBe(true);
    });

    it('fails closed on invalid review thread timestamps', () => {
      expect(() => collectReviewFollowUpItems({
        reviewThreads: [buildReviewThread({
          comments: [
            buildReviewThreadComment({
              id: 'comment-1',
              authorLogin: 'human-reviewer',
              updatedAt: '2026-03-19T10:00:00Z',
              body: 'Add regression coverage for malformed timestamps.',
            }),
            buildReviewThreadComment({
              id: 'comment-2',
              authorLogin: 'human-reviewer',
              updatedAt: 'not-a-timestamp',
              body: 'This timestamp is invalid.',
            }),
          ],
        })],
        currentHeadSha: 'abc123',
      })).toThrow('Invalid timestamp: not-a-timestamp');
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
      expect(replies[0]).toMatchObject({
        threadId: 'thread-1',
        inReplyToCommentId: 'comment-2',
        headSha: 'def456',
      });
      expect(replies[0]?.body).toContain('This reply was prepared by an agent.');
      expect(replies[0]?.body).toContain('def456');
      expect(replies[0]?.body).toContain('agent-stage: implementor');
      expect(replies[0]?.body).toContain('source-comment-id: comment-2');
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

    it('skips informational or no-reply follow-up items', () => {
      const replies = buildImplementorThreadReplyPlans({
        items: [
          {
            threadId: 'thread-1',
            headSha: 'abc123',
            sourceCommentId: 'comment-1',
            summary: 'FYI only',
            actionability: 'informational',
            requiresReply: true,
          },
          {
            threadId: 'thread-2',
            headSha: 'abc123',
            sourceCommentId: 'comment-2',
            summary: 'No reply required',
            actionability: 'actionable',
            requiresReply: false,
          },
        ],
        newHeadSha: 'def456',
        resultSummary: 'Added targeted coverage.',
      });

      expect(replies).toEqual([]);
    });

    it('requires both newHeadSha and resultSummary before planning replies', () => {
      const item: ReviewFollowUpItem = {
        threadId: 'thread-1',
        headSha: 'abc123',
        sourceCommentId: 'comment-2',
        summary: 'Add regression coverage for fallback path',
        actionability: 'actionable',
        requiresReply: true,
      };

      expect(() => buildImplementorThreadReplyPlans({
        items: [item],
        newHeadSha: '',
        resultSummary: 'Added fallback-path regression coverage.',
      })).toThrow('Implementor thread reply planning requires newHeadSha and resultSummary.');

      expect(() => buildImplementorThreadReplyPlans({
        items: [item],
        newHeadSha: 'def456',
        resultSummary: '',
      })).toThrow('Implementor thread reply planning requires newHeadSha and resultSummary.');
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
