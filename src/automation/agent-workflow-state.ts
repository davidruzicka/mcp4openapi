export const ISSUE_WORKFLOW_LABELS = {
  safe: 'agent:safe',
  needsPlan: 'agent:needs-plan',
  planned: 'agent:planned',
  implementing: 'agent:implementing',
  blocked: 'agent:blocked',
  hold: 'human:hold',
} as const;

export const PR_WORKFLOW_LABELS = {
  created: 'agent:created',
  reviewRequired: 'agent:review:required',
  reviewInProgress: 'agent:review:in-progress',
  reviewDone: 'agent:review:done',
  readyToMerge: 'agent:ready-to-merge',
  blocked: 'agent:blocked',
  hold: 'human:hold',
} as const;

export const LEGACY_PR_WORKFLOW_LABELS = {
  reviewing: 'agent:reviewing',
  reviewed: 'agent:reviewed',
} as const;

export type IssueWorkflowState = 'candidate' | 'needs-plan' | 'planned' | 'implementing' | 'blocked' | 'held';
export type PullRequestWorkflowState = 'candidate' | 'review-required' | 'review-in-progress' | 'review-done' | 'ready-to-merge' | 'blocked' | 'held';
export type ReviewerVerdictState = 'approved' | 'changes-requested' | 'commented';

export interface WorkflowLabelMutation {
  readonly labelsToAdd: readonly string[];
  readonly labelsToRemove: readonly string[];
}

export interface PlanIssuerTransitionInput {
  readonly labels: readonly string[];
  readonly suitable: boolean;
}

export interface PlanPlannerTransitionInput {
  readonly labels: readonly string[];
  readonly remainsSuitable: boolean;
  readonly blocked?: boolean;
}

export interface PlanImplementorStartInput {
  readonly labels: readonly string[];
  readonly hasOpenPullRequest?: boolean;
}

export interface PlanImplementorCompletionInput {
  readonly labels: readonly string[];
  readonly outcome: 'pr-created' | 'failed' | 'blocked';
}

const ISSUE_STATE_RULES: ReadonlyArray<{
  readonly state: IssueWorkflowState;
  readonly predicate: (labels: Set<string>) => boolean;
}> = [
  { state: 'held', predicate: (labels) => labels.has(ISSUE_WORKFLOW_LABELS.hold) },
  { state: 'blocked', predicate: (labels) => labels.has(ISSUE_WORKFLOW_LABELS.blocked) },
  { state: 'implementing', predicate: (labels) => labels.has(ISSUE_WORKFLOW_LABELS.implementing) },
  { state: 'planned', predicate: (labels) => labels.has(ISSUE_WORKFLOW_LABELS.planned) },
  {
    state: 'needs-plan',
    predicate: (labels) => labels.has(ISSUE_WORKFLOW_LABELS.safe) || labels.has(ISSUE_WORKFLOW_LABELS.needsPlan),
  },
];

const PR_STATE_RULES: ReadonlyArray<{
  readonly state: PullRequestWorkflowState;
  readonly predicate: (labels: Set<string>) => boolean;
}> = [
  { state: 'held', predicate: (labels) => labels.has(PR_WORKFLOW_LABELS.hold) },
  { state: 'blocked', predicate: (labels) => labels.has(PR_WORKFLOW_LABELS.blocked) },
  { state: 'ready-to-merge', predicate: (labels) => labels.has(PR_WORKFLOW_LABELS.readyToMerge) },
  { state: 'review-in-progress', predicate: hasReviewInProgressSignal },
  { state: 'review-done', predicate: hasReviewDoneSignal },
  { state: 'review-required', predicate: hasReviewLifecycleSignal },
];

const LEGACY_REVIEW_LABELS = Object.values(LEGACY_PR_WORKFLOW_LABELS);
const BLOCKING_LABELS = [ISSUE_WORKFLOW_LABELS.blocked, ISSUE_WORKFLOW_LABELS.hold, PR_WORKFLOW_LABELS.blocked, PR_WORKFLOW_LABELS.hold] as const;

export function detectIssueWorkflowState(labels: readonly string[]): IssueWorkflowState {
  const labelSet = new Set(labels);
  return ISSUE_STATE_RULES.find((rule) => rule.predicate(labelSet))?.state ?? 'candidate';
}

export function detectPullRequestWorkflowState(labels: readonly string[]): PullRequestWorkflowState {
  const labelSet = new Set(labels);
  return PR_STATE_RULES.find((rule) => rule.predicate(labelSet))?.state ?? 'candidate';
}

export function hasBlockingWorkflowLabel(labels: readonly string[]): boolean {
  const labelSet = new Set(labels);
  return BLOCKING_LABELS.some((label) => labelSet.has(label));
}

export function hasReviewLifecycleSignal(labels: Set<string> | readonly string[]): boolean {
  const labelSet = labels instanceof Set ? labels : new Set(labels);
  return [
    PR_WORKFLOW_LABELS.reviewRequired,
    PR_WORKFLOW_LABELS.reviewInProgress,
    PR_WORKFLOW_LABELS.reviewDone,
    PR_WORKFLOW_LABELS.readyToMerge,
    ...LEGACY_REVIEW_LABELS,
  ].some((label) => labelSet.has(label));
}

export function hasReviewInProgressSignal(labels: Set<string> | readonly string[]): boolean {
  const labelSet = labels instanceof Set ? labels : new Set(labels);
  return [PR_WORKFLOW_LABELS.reviewInProgress, LEGACY_PR_WORKFLOW_LABELS.reviewing].some((label) => labelSet.has(label));
}

export function hasReviewDoneSignal(labels: Set<string> | readonly string[]): boolean {
  const labelSet = labels instanceof Set ? labels : new Set(labels);
  return [PR_WORKFLOW_LABELS.reviewDone, LEGACY_PR_WORKFLOW_LABELS.reviewed, PR_WORKFLOW_LABELS.readyToMerge].some((label) => labelSet.has(label));
}

export function planIssuerTransition(input: PlanIssuerTransitionInput): WorkflowLabelMutation {
  const labels = new Set(input.labels);
  if (labels.has(ISSUE_WORKFLOW_LABELS.hold) || labels.has(ISSUE_WORKFLOW_LABELS.planned) || labels.has(ISSUE_WORKFLOW_LABELS.implementing)) {
    return emptyMutation();
  }

  if (input.suitable) {
    return mutation([
      ISSUE_WORKFLOW_LABELS.safe,
      ISSUE_WORKFLOW_LABELS.needsPlan,
    ], [ISSUE_WORKFLOW_LABELS.blocked]);
  }

  return mutation([], [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan]);
}

export function planPlannerTransition(input: PlanPlannerTransitionInput): WorkflowLabelMutation {
  const labels = new Set(input.labels);
  if (labels.has(ISSUE_WORKFLOW_LABELS.hold) || labels.has(ISSUE_WORKFLOW_LABELS.implementing)) {
    return emptyMutation();
  }

  if (input.remainsSuitable) {
    return mutation([
      ISSUE_WORKFLOW_LABELS.planned,
      ISSUE_WORKFLOW_LABELS.safe,
    ], [ISSUE_WORKFLOW_LABELS.needsPlan, ISSUE_WORKFLOW_LABELS.blocked]);
  }

  return mutation(
    input.blocked ? [ISSUE_WORKFLOW_LABELS.blocked] : [],
    [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan, ISSUE_WORKFLOW_LABELS.planned],
  );
}

export function planImplementorStart(input: PlanImplementorStartInput): WorkflowLabelMutation {
  const labels = new Set(input.labels);
  if (labels.has(ISSUE_WORKFLOW_LABELS.hold) || labels.has(ISSUE_WORKFLOW_LABELS.implementing) || input.hasOpenPullRequest) {
    return emptyMutation();
  }

  if (!labels.has(ISSUE_WORKFLOW_LABELS.safe) || !labels.has(ISSUE_WORKFLOW_LABELS.planned)) {
    return emptyMutation();
  }

  return mutation([ISSUE_WORKFLOW_LABELS.implementing], [ISSUE_WORKFLOW_LABELS.blocked]);
}

export function planImplementorCompletion(input: PlanImplementorCompletionInput): WorkflowLabelMutation {
  if (input.outcome === 'pr-created') {
    return mutation([], [ISSUE_WORKFLOW_LABELS.implementing]);
  }

  if (input.outcome === 'blocked') {
    return mutation([ISSUE_WORKFLOW_LABELS.blocked], [ISSUE_WORKFLOW_LABELS.implementing]);
  }

  return mutation([], [ISSUE_WORKFLOW_LABELS.implementing]);
}

export function planReviewerCompletion(labels: readonly string[], verdict: ReviewerVerdictState): WorkflowLabelMutation {
  const removeLabels = [PR_WORKFLOW_LABELS.reviewInProgress, ...LEGACY_REVIEW_LABELS];
  if (verdict === 'changes-requested') {
    return mutation([], [PR_WORKFLOW_LABELS.reviewDone, ...removeLabels]);
  }

  return mutation([PR_WORKFLOW_LABELS.reviewDone], removeLabels);
}

function emptyMutation(): WorkflowLabelMutation {
  return { labelsToAdd: [], labelsToRemove: [] };
}

function mutation(labelsToAdd: readonly string[], labelsToRemove: readonly string[]): WorkflowLabelMutation {
  return {
    labelsToAdd: uniqueLabels(labelsToAdd),
    labelsToRemove: uniqueLabels(labelsToRemove),
  };
}

function uniqueLabels(labels: readonly string[]): readonly string[] {
  return [...new Set(labels)];
}
