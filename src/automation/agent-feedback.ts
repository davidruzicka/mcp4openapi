export type AgentStage = 'issuer' | 'planner' | 'implementor' | 'reviewer' | 'merger' | 'evaluator';

export type FeedbackVerdict = 'positive' | 'neutral' | 'negative';

export interface FeedbackCategoryDefinition {
  readonly category: string;
  readonly severity: 'low' | 'medium' | 'high';
  readonly prompt: string;
  readonly expectedBehavior: string;
}

export interface FeedbackFollowUpPolicy {
  readonly requestDetailsWithoutComment: boolean;
  readonly intro: string;
  readonly templatePrefix: string;
  readonly categories: readonly FeedbackCategoryDefinition[];
}

export interface EvaluatorFeedbackRequestInput {
  readonly stage: Exclude<AgentStage, 'evaluator'>;
  readonly verdict: Exclude<FeedbackVerdict, 'neutral'>;
  readonly targetAgentId: string;
  readonly targetType: 'issue' | 'pull_request' | 'review' | 'comment';
  readonly targetNumber: number;
  readonly reactionSource: 'thumbs_up' | 'thumbs_down';
  readonly runId: string;
  readonly timestamp: string;
  readonly repository?: string;
  readonly contextSummary?: string;
  readonly humanComment?: string;
  readonly headSha?: string;
  readonly issueNumber?: number;
  readonly prNumber?: number;
}

export const FEEDBACK_FOLLOW_UP_POLICIES: Record<Exclude<AgentStage, 'evaluator'>, Record<Exclude<FeedbackVerdict, 'neutral'>, FeedbackFollowUpPolicy>> = {
  issuer: {
    positive: {
      requestDetailsWithoutComment: false,
      intro: 'Thanks for the positive signal. Optional detail can help confirm why issue triage worked well.',
      templatePrefix: 'strong-safe-classification',
      categories: [
        {
          category: 'strong-safe-classification',
          severity: 'low',
          prompt: 'issuer selected the right issue shape and autonomy gate',
          expectedBehavior: 'issuer should keep routing similarly scoped issues into the autonomous lane',
        },
      ],
    },
    negative: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the feedback. A short clarification helps tighten the autonomy gate for issue triage.',
      templatePrefix: 'wrong-safe-classification',
      categories: [
        {
          category: 'wrong-safe-classification',
          severity: 'high',
          prompt: 'issuer marked an issue safe even though it needed human judgment, broader design, or extra risk review',
          expectedBehavior: 'issuer should leave broad, risky, or ambiguous issues for human triage or planning',
        },
        {
          category: 'missed-safe-opportunity',
          severity: 'medium',
          prompt: 'issuer left a clearly scoped low-risk issue out of the autonomous lane',
          expectedBehavior: 'issuer should accept similar small, testable issues in the future',
        },
      ],
    },
  },
  planner: {
    positive: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the positive signal. A short note helps preserve strong planning patterns.',
      templatePrefix: 'useful-plan',
      categories: [
        {
          category: 'useful-plan',
          severity: 'low',
          prompt: 'plan was concrete, modular, and easy to implement safely',
          expectedBehavior: 'planner should keep giving impacted modules, validation steps, and test guidance',
        },
      ],
    },
    negative: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the feedback. A short clarification helps improve planning quality before implementation starts.',
      templatePrefix: 'insufficient-plan-detail',
      categories: [
        {
          category: 'insufficient-plan-detail',
          severity: 'medium',
          prompt: 'plan was too vague to implement confidently',
          expectedBehavior: 'planner should provide explicit steps, impacted files/modules, and validation expectations',
        },
        {
          category: 'missed-risk',
          severity: 'high',
          prompt: 'plan missed an important edge case, safety concern, or compatibility constraint',
          expectedBehavior: 'planner should surface key risks before implementation begins',
        },
        {
          category: 'bad-modularization-plan',
          severity: 'medium',
          prompt: 'plan encouraged coupling, weak boundaries, or unnecessary complexity',
          expectedBehavior: 'planner should prefer modular, low-risk changes with clean boundaries',
        },
      ],
    },
  },
  implementor: {
    positive: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the positive signal. A short note helps reinforce what good autonomous implementation looks like.',
      templatePrefix: 'clean-implementation',
      categories: [
        {
          category: 'clean-implementation',
          severity: 'low',
          prompt: 'implementation stayed focused, readable, and well tested',
          expectedBehavior: 'implementor should keep changes narrow, modular, and validated by tests',
        },
        {
          category: 'strong-test-coverage',
          severity: 'low',
          prompt: 'implementation added the right regression and edge-case coverage',
          expectedBehavior: 'implementor should keep adding targeted success and failure-path tests',
        },
      ],
    },
    negative: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the feedback. A short clarification helps improve future implementation prompts and guardrails.',
      templatePrefix: 'incorrect-implementation',
      categories: [
        {
          category: 'incorrect-implementation',
          severity: 'high',
          prompt: 'implementation did not satisfy the intended behavior or introduced a defect',
          expectedBehavior: 'implementor should preserve correctness before optimizing for speed',
        },
        {
          category: 'scope-creep',
          severity: 'medium',
          prompt: 'implementation changed more than the issue or plan justified',
          expectedBehavior: 'implementor should keep the diff tightly scoped to the approved plan',
        },
        {
          category: 'insufficient-tests',
          severity: 'medium',
          prompt: 'implementation missed needed validation or regression coverage',
          expectedBehavior: 'implementor should add focused tests for success paths and edge cases',
        },
        {
          category: 'overengineered',
          severity: 'medium',
          prompt: 'implementation added unnecessary abstraction or complexity',
          expectedBehavior: 'implementor should prefer the simplest modular solution that satisfies the issue',
        },
      ],
    },
  },
  reviewer: {
    positive: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the positive signal. A short note helps preserve high-value review behavior.',
      templatePrefix: 'useful-review',
      categories: [
        {
          category: 'useful-review',
          severity: 'low',
          prompt: 'review caught relevant issues or gave clear confidence on the final patch',
          expectedBehavior: 'reviewer should keep producing concise, relevant review guidance tied to the current head SHA',
        },
        {
          category: 'good-re-review',
          severity: 'low',
          prompt: 'reviewer correctly noticed new commits and re-reviewed the updated PR state',
          expectedBehavior: 'reviewer should continue invalidating stale approvals when head SHA changes',
        },
      ],
    },
    negative: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the feedback. A short clarification helps improve review prompts and approval gates.',
      templatePrefix: 'missed-defect',
      categories: [
        {
          category: 'missed-defect',
          severity: 'high',
          prompt: 'reviewer overlooked a correctness, safety, or test gap that should have blocked approval',
          expectedBehavior: 'reviewer should catch material defects before approving',
        },
        {
          category: 'false-positive-review',
          severity: 'medium',
          prompt: 'reviewer requested changes that were unnecessary or not grounded in the issue/plan',
          expectedBehavior: 'reviewer should focus on material defects, not speculative churn',
        },
        {
          category: 'insufficient-depth',
          severity: 'medium',
          prompt: 'review stayed too superficial and did not check important edge cases or tests',
          expectedBehavior: 'reviewer should verify behavior, tests, and obvious failure paths',
        },
        {
          category: 'stale-review-not-detected',
          severity: 'high',
          prompt: 'reviewer treated an older approval as valid after new commits were pushed',
          expectedBehavior: 'reviewer should compare the reviewed head SHA with the current PR head SHA before approving',
        },
      ],
    },
  },
  merger: {
    positive: {
      requestDetailsWithoutComment: false,
      intro: 'Thanks for the positive signal. Optional detail can help preserve safe merge behavior.',
      templatePrefix: 'safe-merge',
      categories: [
        {
          category: 'safe-merge',
          severity: 'low',
          prompt: 'merger respected review, CI, and hold gates correctly',
          expectedBehavior: 'merger should continue merging only after all required checks are current and green',
        },
      ],
    },
    negative: {
      requestDetailsWithoutComment: true,
      intro: 'Thanks for the feedback. A short clarification helps harden merge gates and escalation rules.',
      templatePrefix: 'merged-too-early',
      categories: [
        {
          category: 'merged-too-early',
          severity: 'high',
          prompt: 'merger acted before all required reviews, CI, or responses were complete',
          expectedBehavior: 'merger should wait for current-sha approvals, green CI, and no active blockers',
        },
        {
          category: 'merged-with-open-concerns',
          severity: 'high',
          prompt: 'merger ignored unresolved review conversations or explicit holds',
          expectedBehavior: 'merger should stop when review threads or human hold signals remain open',
        },
        {
          category: 'merge-policy-violation',
          severity: 'high',
          prompt: 'merger did not follow the documented merge policy for this repository',
          expectedBehavior: 'merger should enforce the repository merge checklist deterministically',
        },
      ],
    },
  },
};

export function shouldRequestFeedbackDetails(stage: Exclude<AgentStage, 'evaluator'>, verdict: Exclude<FeedbackVerdict, 'neutral'>, humanComment?: string): boolean {
  if (hasMeaningfulComment(humanComment)) {
    return false;
  }

  return FEEDBACK_FOLLOW_UP_POLICIES[stage][verdict].requestDetailsWithoutComment;
}

export function buildAgentMetadataBlock(entries: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const lines = Object.entries(entries)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`);

  return ['<!-- AGENT-METADATA', ...lines, '-->'].join('\n');
}

export function buildEvaluatorFeedbackRequestComment(input: EvaluatorFeedbackRequestInput): string {
  const policy = FEEDBACK_FOLLOW_UP_POLICIES[input.stage][input.verdict];
  const quickReplyTemplate = `${policy.templatePrefix} / ${policy.categories[0]?.severity ?? 'medium'} / ${policy.categories[0]?.prompt}`;
  const targetReference = `#${input.targetNumber}`;
  const contextLines = [
    input.contextSummary,
    input.headSha ? `Current head SHA: ${input.headSha}` : undefined,
  ].filter(Boolean);

  const categoryBullets = policy.categories
    .map(({ category, severity, prompt, expectedBehavior }) => `- ${category} (${severity}): ${prompt}; expected: ${expectedBehavior}`)
    .join('\n');

  const metadataBlock = buildAgentMetadataBlock({
    'agent-id': 'evaluator',
    'agent-role': 'feedback-request',
    repository: input.repository,
    'target-agent-id': input.targetAgentId,
    'target-type': input.targetType,
    'target-number': input.targetNumber,
    'issue-number': input.issueNumber,
    'pr-number': input.prNumber,
    'head-sha': input.headSha,
    verdict: input.verdict,
    'reaction-source': input.reactionSource,
    status: 'awaiting-human-feedback',
    'ignore-for-workflow': true,
    'run-id': input.runId,
    timestamp: input.timestamp,
  });

  return [
    '🤖 Evaluator note',
    '',
    policy.intro,
    '',
    `Target: ${input.stage} on ${input.targetType} ${targetReference}`,
    ...(contextLines.length > 0 ? ['', ...contextLines] : []),
    '',
    'If useful, reply with one short line using this template:',
    `${policy.templatePrefix} / severity / what happened / expected behavior`,
    '',
    'Suggested categories for this situation:',
    categoryBullets,
    '',
    'Quick reply example:',
    quickReplyTemplate,
    '',
    'If none of these fit, a short free-text reply is also fine.',
    '',
    metadataBlock,
  ].join('\n');
}

function hasMeaningfulComment(humanComment?: string): boolean {
  return Boolean(humanComment && humanComment.trim().length >= 8);
}
