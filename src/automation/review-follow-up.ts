import { buildAgentMetadataBlock } from './agent-feedback.js';
import { parseAgentMetadata } from './evaluator-runner.js';

export type ReviewFollowUpActionability = 'actionable' | 'informational' | 'obsolete';

export interface ReviewCommentLike {
  readonly id: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface ReviewThreadLike {
  readonly id: string;
  readonly isResolved: boolean;
  readonly comments: readonly ReviewCommentLike[];
}

export interface ReviewFollowUpItem {
  readonly threadId: string;
  readonly headSha: string;
  readonly sourceCommentId: string;
  readonly summary: string;
  readonly actionability: ReviewFollowUpActionability;
  readonly requiresReply: boolean;
}

export interface ImplementorThreadReplyPlan {
  readonly threadId: string;
  readonly headSha: string;
  readonly body: string;
}

export function collectReviewFollowUpItems(input: {
  readonly reviewThreads: readonly ReviewThreadLike[];
  readonly currentHeadSha: string;
}): ReviewFollowUpItem[] {
  return input.reviewThreads.flatMap((thread) => {
    const threadHeadSha = detectThreadHeadSha(thread, input.currentHeadSha);
    if (threadHeadSha !== input.currentHeadSha || thread.isResolved) {
      return [];
    }

    const latestExternalComment = [...thread.comments]
      .filter((comment) => !isAgentComment(comment.body))
      .sort((left, right) => parseIsoTimestamp(left.updatedAt) - parseIsoTimestamp(right.updatedAt))
      .at(-1);
    if (!latestExternalComment) {
      return [];
    }

    return [{
      threadId: thread.id,
      headSha: input.currentHeadSha,
      sourceCommentId: latestExternalComment.id,
      summary: summarizeReviewComment(latestExternalComment.body),
      actionability: 'actionable',
      requiresReply: true,
    }];
  });
}

export function buildImplementorThreadReplyPlans(input: {
  readonly items: readonly ReviewFollowUpItem[];
  readonly newHeadSha: string;
  readonly resultSummary: string;
}): ImplementorThreadReplyPlan[] {
  if (!input.newHeadSha || !input.resultSummary) {
    throw new Error('Implementor thread reply planning requires newHeadSha and resultSummary.');
  }

  const uniqueItems = new Map<string, ReviewFollowUpItem>();
  for (const item of input.items) {
    if (item.actionability !== 'actionable' || !item.requiresReply) {
      continue;
    }
    validateReviewFollowUpItem(item);
    uniqueItems.set(item.threadId, item);
  }

  return [...uniqueItems.values()].map((item) => ({
    threadId: item.threadId,
    headSha: input.newHeadSha,
    body: buildImplementorThreadReplyBody({
      previousHeadSha: item.headSha,
      newHeadSha: input.newHeadSha,
      resultSummary: input.resultSummary,
      threadId: item.threadId,
      sourceCommentId: item.sourceCommentId,
    }),
  }));
}

function buildImplementorThreadReplyBody(input: {
  readonly previousHeadSha: string;
  readonly newHeadSha: string;
  readonly resultSummary: string;
  readonly threadId: string;
  readonly sourceCommentId: string;
}): string {
  const metadataBlock = buildAgentMetadataBlock({
    'agent-stage': 'implementor',
    'agent-role': 'review-follow-up-reply',
    status: 'review-follow-up-replied',
    'head-sha': input.newHeadSha,
    'source-head-sha': input.previousHeadSha,
    'thread-id': input.threadId,
    'source-comment-id': input.sourceCommentId,
  });

  return [
    '🤖 Agent implementation note (implementor)',
    '',
    'This reply was prepared by an agent.',
    `Updated head SHA: ${input.newHeadSha}`,
    `Summary: ${input.resultSummary}`,
    '',
    metadataBlock,
  ].join('\n');
}

function validateReviewFollowUpItem(item: ReviewFollowUpItem): void {
  if (!item.threadId || !item.headSha || !item.sourceCommentId || !item.summary) {
    throw new Error('Invalid review follow-up item: missing threadId, headSha, sourceCommentId, or summary.');
  }
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

function summarizeReviewComment(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function isAgentComment(body: string): boolean {
  return parseAgentMetadata(body) !== undefined;
}

function parseIsoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid timestamp: ${value}`);
  }

  return timestamp;
}
