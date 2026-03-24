import { describe, expect, it } from 'vitest';
import { resolveReviewThreadStates, type ReviewThreadStateInput } from './review-resolution-state.js';

describe('review-resolution-state', () => {
  it('classifies a current-head unresolved thread as open', () => {
    const states = resolveReviewThreadStates({
      reviewThreads: [buildReviewThread({ id: 'thread-1', isResolved: false })],
      currentHeadSha: 'abc123',
    });

    expect(states).toEqual([
      expect.objectContaining({
        threadId: 'thread-1',
        headSha: 'abc123',
        state: 'open',
        blocking: true,
      }),
    ]);
  });

  it('classifies a current-head thread with an implementor follow-up reply as addressed', () => {
    const states = resolveReviewThreadStates({
      reviewThreads: [buildReviewThread({
        id: 'thread-1',
        isResolved: true,
        comments: [
          buildComment({ id: 'comment-1', authorLogin: 'human-reviewer', body: 'Please cover the fallback path.' }),
          buildComment({
            id: 'comment-2',
            authorLogin: 'github-actions[bot]',
            updatedAt: '2026-03-19T10:05:00Z',
            body: buildAgentComment({
              stage: 'implementor',
              status: 'review-follow-up-replied',
              headSha: 'abc123',
              timestamp: '2026-03-19T10:05:00Z',
            }),
          }),
        ],
      })],
      currentHeadSha: 'abc123',
    });

    expect(states[0]).toMatchObject({
      state: 'addressed',
      blocking: false,
    });
  });

  it('classifies an old-head thread as obsolete after a new commit', () => {
    const states = resolveReviewThreadStates({
      reviewThreads: [buildReviewThread({
        id: 'thread-1',
        isResolved: false,
        comments: [buildComment({
          id: 'comment-1',
          body: buildAgentComment({
            stage: 'reviewer',
            status: 'commented',
            headSha: 'old-sha',
            timestamp: '2026-03-19T10:00:00Z',
          }),
        })],
      })],
      currentHeadSha: 'new-sha',
    });

    expect(states[0]).toMatchObject({
      state: 'obsolete',
      blocking: false,
      headSha: 'old-sha',
    });
  });

  it('treats a resolved current-head thread as addressed even without an implementor reply', () => {
    const states = resolveReviewThreadStates({
      reviewThreads: [buildReviewThread({
        id: 'thread-1',
        isResolved: true,
        comments: [buildComment({
          id: 'comment-1',
          body: buildAgentComment({
            stage: 'reviewer',
            status: 'commented',
            headSha: 'abc123',
            timestamp: '2026-03-19T10:00:00Z',
          }),
        })],
      })],
      currentHeadSha: 'abc123',
    });

    expect(states[0]).toMatchObject({
      state: 'addressed',
      blocking: false,
    });
  });
});

function buildReviewThread(overrides: Partial<ReviewThreadStateInput['reviewThreads'][number]> = {}): ReviewThreadStateInput['reviewThreads'][number] {
  return {
    id: 'thread-1',
    isResolved: false,
    comments: [],
    ...overrides,
  };
}

function buildComment(overrides: Partial<ReviewThreadStateInput['reviewThreads'][number]['comments'][number]> = {}): ReviewThreadStateInput['reviewThreads'][number]['comments'][number] {
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
