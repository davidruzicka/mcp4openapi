import { parseAgentMetadata } from './evaluator-runner.js';
import type { ReviewThreadLike } from './review-follow-up.js';

export type ReviewThreadResolutionState = 'open' | 'addressed' | 'obsolete';

export interface ResolvedReviewThreadState {
  readonly threadId: string;
  readonly headSha: string;
  readonly state: ReviewThreadResolutionState;
  readonly blocking: boolean;
  readonly summary: string;
}

export interface ReviewThreadStateInput {
  readonly reviewThreads: readonly ReviewThreadLike[];
  readonly currentHeadSha: string;
}

export function resolveReviewThreadStates(input: ReviewThreadStateInput): ResolvedReviewThreadState[] {
  return input.reviewThreads.map((thread) => {
    const headSha = detectThreadHeadSha(thread, input.currentHeadSha);
    if (headSha !== input.currentHeadSha) {
      return {
        threadId: thread.id,
        headSha,
        state: 'obsolete',
        blocking: false,
        summary: 'Thread belongs to an older PR head and is obsolete for merge gating.',
      };
    }

    if (hasImplementorReplyForHead(thread, input.currentHeadSha)) {
      return {
        threadId: thread.id,
        headSha: input.currentHeadSha,
        state: 'addressed',
        blocking: false,
        summary: 'Current-head thread contains an implementor follow-up reply.',
      };
    }

    if (thread.isResolved) {
      return {
        threadId: thread.id,
        headSha: input.currentHeadSha,
        state: 'addressed',
        blocking: false,
        summary: 'Current-head review thread is resolved on GitHub and does not block merge readiness.',
      };
    }

    return {
      threadId: thread.id,
      headSha: input.currentHeadSha,
      state: 'open',
      blocking: true,
      summary: 'Current-head review thread remains open.',
    };
  });
}

function detectThreadHeadSha(thread: ReviewThreadLike, currentHeadSha: string): string {
  const threadHeadShas = thread.comments
    .map((comment) => parseAgentMetadata(comment.body)?.['head-sha'])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (threadHeadShas.includes(currentHeadSha)) {
    return currentHeadSha;
  }

  return threadHeadShas[0] ?? currentHeadSha;
}

function hasImplementorReplyForHead(thread: ReviewThreadLike, headSha: string): boolean {
  return thread.comments.some((comment) => {
    const metadata = parseAgentMetadata(comment.body);
    return metadata?.['agent-stage'] === 'implementor'
      && metadata?.['ignore-for-workflow'] !== 'true'
      && metadata?.['head-sha'] === headSha;
  });
}
