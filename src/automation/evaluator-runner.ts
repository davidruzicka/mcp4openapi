import {
  buildEvaluatorFeedbackRequestComment,
  shouldRequestFeedbackDetails,
  type AgentStage,
} from './agent-feedback.js';

export interface ReactionSummary {
  readonly ['+1']?: number;
  readonly ['-1']?: number;
}

export interface EvaluatorTargetArtifact {
  readonly id: number;
  readonly issueNumber: number;
  readonly prNumber?: number;
  readonly targetType: 'issue' | 'pull_request' | 'comment';
  readonly agentId: string;
  readonly stage: Exclude<AgentStage, 'evaluator'>;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly reactions: ReactionSummary;
}

export interface IssueThreadComment {
  readonly id: number;
  readonly issueNumber: number;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorLogin: string;
}

export interface EvaluatorFollowUpRequest {
  readonly issueNumber: number;
  readonly targetType: EvaluatorTargetArtifact['targetType'];
  readonly targetNumber: number;
  readonly targetAgentId: string;
  readonly stage: EvaluatorTargetArtifact['stage'];
  readonly verdict: 'positive' | 'negative';
  readonly commentBody: string;
}

export interface CollectEvaluatorFollowUpRequestsInput {
  readonly targetArtifacts: readonly EvaluatorTargetArtifact[];
  readonly threadComments: readonly IssueThreadComment[];
  readonly repository: string;
  readonly runId: string;
  readonly now: string;
}

export type AgentMetadata = Readonly<Record<string, string>>;

const STAGE_VALUES: readonly Exclude<AgentStage, 'evaluator'>[] = ['issuer', 'planner', 'implementor', 'reviewer', 'merger'];

const STAGE_HINTS: Readonly<Record<Exclude<AgentStage, 'evaluator'>, readonly string[]>> = {
  issuer: ['issuer', 'triage', 'classification'],
  planner: ['planner', 'plan', 'planning'],
  implementor: ['implementor', 'implementation', 'implement'],
  reviewer: ['reviewer', 'review'],
  merger: ['merger', 'merge'],
};

export function parseAgentMetadata(body: string): AgentMetadata | undefined {
  const metadataMatch = body.match(/<!--\s*AGENT-METADATA\n([\s\S]*?)\n-->/);
  if (!metadataMatch) {
    return undefined;
  }

  const entries = metadataMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex < 0) {
        return undefined;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (!key || !value) {
        return undefined;
      }

      return [key, value] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== undefined);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

export function resolveStageFromMetadata(metadata: AgentMetadata): Exclude<AgentStage, 'evaluator'> | undefined {
  const explicitStage = metadata['agent-stage'];
  if (isStage(explicitStage)) {
    return explicitStage;
  }

  const haystack = [metadata['agent-role'], metadata['agent-id']]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  return STAGE_VALUES.find((stage) => STAGE_HINTS[stage].some((hint) => haystack.some((value) => value.includes(hint))));
}

export function selectVerdictFromReactions(reactions: ReactionSummary): 'positive' | 'negative' | undefined {
  const positiveCount = reactions['+1'] ?? 0;
  const negativeCount = reactions['-1'] ?? 0;

  if (positiveCount > 0 && negativeCount > 0) {
    return undefined;
  }

  if (negativeCount > 0) {
    return 'negative';
  }

  if (positiveCount > 0) {
    return 'positive';
  }

  return undefined;
}

export function collectEvaluatorFollowUpRequests(input: CollectEvaluatorFollowUpRequestsInput): EvaluatorFollowUpRequest[] {
  const existingRequests = new Set(
    input.threadComments
      .map((comment) => parseAgentMetadata(comment.body))
      .filter((metadata): metadata is AgentMetadata => metadata !== undefined)
      .filter((metadata) => metadata['agent-id'] === 'evaluator')
      .filter((metadata) => metadata.status === 'awaiting-human-feedback')
      .map((metadata) => `${metadata['target-type']}:${metadata['target-number']}`),
  );

  return input.targetArtifacts.flatMap((artifact) => {
    if (artifact.agentId === 'evaluator') {
      return [];
    }

    const metadata = parseAgentMetadata(artifact.body);
    if (metadata?.['ignore-for-workflow'] === 'true') {
      return [];
    }

    const verdict = selectVerdictFromReactions(artifact.reactions);
    if (!verdict) {
      return [];
    }

    if (!shouldRequestFeedbackDetails(artifact.stage, verdict)) {
      return [];
    }

    const targetKey = `${artifact.targetType}:${artifact.id}`;
    if (existingRequests.has(targetKey)) {
      return [];
    }

    const commentBody = buildEvaluatorFeedbackRequestComment({
      stage: artifact.stage,
      verdict,
      targetAgentId: artifact.agentId,
      targetType: artifact.targetType,
      targetNumber: artifact.id,
      reactionSource: verdict === 'negative' ? 'thumbs_down' : 'thumbs_up',
      runId: input.runId,
      timestamp: input.now,
      repository: input.repository,
      contextSummary: `Feedback target: ${artifact.url}`,
      issueNumber: artifact.issueNumber,
      prNumber: artifact.prNumber,
    });

    return [{
      issueNumber: artifact.issueNumber,
      targetType: artifact.targetType,
      targetNumber: artifact.id,
      targetAgentId: artifact.agentId,
      stage: artifact.stage,
      verdict,
      commentBody,
    }];
  });
}

function isStage(value: string | undefined): value is Exclude<AgentStage, 'evaluator'> {
  return STAGE_VALUES.includes(value as Exclude<AgentStage, 'evaluator'>);
}
