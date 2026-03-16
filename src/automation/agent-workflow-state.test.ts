import { describe, expect, it } from 'vitest';
import {
  PR_WORKFLOW_LABELS,
  ISSUE_WORKFLOW_LABELS,
  LEGACY_PR_WORKFLOW_LABELS,
  detectIssueWorkflowState,
  detectPullRequestWorkflowState,
  hasBlockingWorkflowLabel,
  hasReviewDoneSignal,
  hasReviewInProgressSignal,
  hasReviewLifecycleSignal,
  planImplementorCompletion,
  planImplementorStart,
  planIssuerTransition,
  planPlannerTransition,
  planReviewerCompletion,
} from './agent-workflow-state.js';

describe('agent-workflow-state', () => {
  describe('detectIssueWorkflowState', () => {
    it('maps the final issue taxonomy to deterministic states', () => {
      expect(detectIssueWorkflowState([])).toBe('candidate');
      expect(detectIssueWorkflowState([ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan])).toBe('needs-plan');
      expect(detectIssueWorkflowState([ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.planned])).toBe('planned');
      expect(detectIssueWorkflowState([ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.planned, ISSUE_WORKFLOW_LABELS.implementing])).toBe('implementing');
      expect(detectIssueWorkflowState([ISSUE_WORKFLOW_LABELS.blocked])).toBe('blocked');
      expect(detectIssueWorkflowState([ISSUE_WORKFLOW_LABELS.hold])).toBe('held');
    });
  });

  describe('detectPullRequestWorkflowState', () => {
    it('maps review and merge labels including legacy review hints', () => {
      expect(detectPullRequestWorkflowState([])).toBe('candidate');
      expect(detectPullRequestWorkflowState([PR_WORKFLOW_LABELS.reviewRequired])).toBe('review-required');
      expect(detectPullRequestWorkflowState([LEGACY_PR_WORKFLOW_LABELS.reviewing])).toBe('review-in-progress');
      expect(detectPullRequestWorkflowState([LEGACY_PR_WORKFLOW_LABELS.reviewed])).toBe('review-done');
      expect(detectPullRequestWorkflowState([PR_WORKFLOW_LABELS.readyToMerge])).toBe('ready-to-merge');
      expect(detectPullRequestWorkflowState([PR_WORKFLOW_LABELS.blocked])).toBe('blocked');
      expect(detectPullRequestWorkflowState([PR_WORKFLOW_LABELS.hold])).toBe('held');
    });
  });

  describe('hasBlockingWorkflowLabel', () => {
    it('detects issue and pull-request hold/block labels', () => {
      expect(hasBlockingWorkflowLabel([ISSUE_WORKFLOW_LABELS.blocked])).toBe(true);
      expect(hasBlockingWorkflowLabel([PR_WORKFLOW_LABELS.hold])).toBe(true);
      expect(hasBlockingWorkflowLabel([PR_WORKFLOW_LABELS.reviewRequired])).toBe(false);
    });
  });

  describe('hasReviewLifecycleSignal', () => {
    it('accepts legacy and final review labels during migration', () => {
      expect(hasReviewLifecycleSignal([PR_WORKFLOW_LABELS.reviewRequired])).toBe(true);
      expect(hasReviewLifecycleSignal([LEGACY_PR_WORKFLOW_LABELS.reviewing])).toBe(true);
      expect(hasReviewLifecycleSignal([LEGACY_PR_WORKFLOW_LABELS.reviewed])).toBe(true);
      expect(hasReviewLifecycleSignal([])).toBe(false);
    });

    it('accepts Set inputs for in-progress and done review lane helpers', () => {
      expect(hasReviewInProgressSignal(new Set([LEGACY_PR_WORKFLOW_LABELS.reviewing]))).toBe(true);
      expect(hasReviewDoneSignal(new Set([PR_WORKFLOW_LABELS.readyToMerge]))).toBe(true);
      expect(hasReviewDoneSignal(new Set<string>())).toBe(false);
    });
  });

  describe('planIssuerTransition', () => {
    it('moves suitable candidate issues into safe + needs-plan', () => {
      expect(planIssuerTransition({ labels: [], suitable: true })).toEqual({
        labelsToAdd: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.blocked],
      });
    });

    it('removes stale safe labels when an issue is no longer suitable', () => {
      expect(planIssuerTransition({ labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan], suitable: false })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan],
      });
    });

    it('keeps proposal-intake entry labels stable when the issue is already safe and awaiting planning', () => {
      expect(planIssuerTransition({ labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan], suitable: true })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });
    });

    it('only clears stale blocked labels when a suitable issue is already in the safe planning lane', () => {
      expect(planIssuerTransition({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan, ISSUE_WORKFLOW_LABELS.blocked],
        suitable: true,
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.blocked],
      });
    });

    it('keeps held, planned, or implementing issues out of issuer transitions', () => {
      expect(planIssuerTransition({ labels: [ISSUE_WORKFLOW_LABELS.hold], suitable: true })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });
      expect(planIssuerTransition({ labels: [ISSUE_WORKFLOW_LABELS.planned], suitable: true })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });
      expect(planIssuerTransition({ labels: [ISSUE_WORKFLOW_LABELS.implementing], suitable: true })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });
    });
  });

  describe('planPlannerTransition', () => {
    it('promotes suitable work from needs-plan to planned', () => {
      expect(planPlannerTransition({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan],
        remainsSuitable: true,
      })).toEqual({
        labelsToAdd: [ISSUE_WORKFLOW_LABELS.planned, ISSUE_WORKFLOW_LABELS.safe],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.needsPlan, ISSUE_WORKFLOW_LABELS.blocked],
      });
    });

    it('de-scopes unsuitable work and can mark it blocked', () => {
      expect(planPlannerTransition({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan],
        remainsSuitable: false,
        blocked: true,
      })).toEqual({
        labelsToAdd: [ISSUE_WORKFLOW_LABELS.blocked],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan, ISSUE_WORKFLOW_LABELS.planned],
      });
    });

    it('returns no planner mutation for held or implementing issues and can de-scope without adding blocked', () => {
      expect(planPlannerTransition({
        labels: [ISSUE_WORKFLOW_LABELS.hold],
        remainsSuitable: true,
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });

      expect(planPlannerTransition({
        labels: [ISSUE_WORKFLOW_LABELS.implementing],
        remainsSuitable: true,
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });

      expect(planPlannerTransition({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan],
        remainsSuitable: false,
        blocked: false,
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.needsPlan, ISSUE_WORKFLOW_LABELS.planned],
      });
    });
  });

  describe('planImplementorStart', () => {
    it('starts implementation only for safe planned issues without an open PR', () => {
      expect(planImplementorStart({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.planned],
      })).toEqual({
        labelsToAdd: [ISSUE_WORKFLOW_LABELS.implementing],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.blocked],
      });
    });

    it('refuses to start when a linked PR already exists', () => {
      expect(planImplementorStart({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.planned],
        hasOpenPullRequest: true,
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });
    });

    it('refuses to start without both safe and planned labels or when work is already held/in progress', () => {
      expect(planImplementorStart({
        labels: [ISSUE_WORKFLOW_LABELS.safe],
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });

      expect(planImplementorStart({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.planned, ISSUE_WORKFLOW_LABELS.hold],
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });
      expect(planImplementorStart({
        labels: [ISSUE_WORKFLOW_LABELS.safe, ISSUE_WORKFLOW_LABELS.planned, ISSUE_WORKFLOW_LABELS.implementing],
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [],
      });
    });
  });

  describe('planImplementorCompletion', () => {
    it('clears implementing after a PR is created or a safe failure occurs', () => {
      expect(planImplementorCompletion({
        labels: [ISSUE_WORKFLOW_LABELS.implementing],
        outcome: 'pr-created',
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.implementing],
      });

      expect(planImplementorCompletion({
        labels: [ISSUE_WORKFLOW_LABELS.implementing],
        outcome: 'failed',
      })).toEqual({
        labelsToAdd: [],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.implementing],
      });
    });

    it('marks blocked failures explicitly', () => {
      expect(planImplementorCompletion({
        labels: [ISSUE_WORKFLOW_LABELS.implementing],
        outcome: 'blocked',
      })).toEqual({
        labelsToAdd: [ISSUE_WORKFLOW_LABELS.blocked],
        labelsToRemove: [ISSUE_WORKFLOW_LABELS.implementing],
      });
    });
  });

  describe('planReviewerCompletion', () => {
    it('writes final review labels and removes legacy review labels after approval', () => {
      expect(planReviewerCompletion([
        LEGACY_PR_WORKFLOW_LABELS.reviewed,
        PR_WORKFLOW_LABELS.reviewInProgress,
      ], 'approved')).toEqual({
        labelsToAdd: [PR_WORKFLOW_LABELS.reviewDone],
        labelsToRemove: [
          PR_WORKFLOW_LABELS.reviewInProgress,
          LEGACY_PR_WORKFLOW_LABELS.reviewing,
          LEGACY_PR_WORKFLOW_LABELS.reviewed,
        ],
      });
    });

    it('keeps review-required and clears done/in-progress labels after changes-requested', () => {
      expect(planReviewerCompletion([
        PR_WORKFLOW_LABELS.reviewRequired,
        PR_WORKFLOW_LABELS.reviewDone,
        LEGACY_PR_WORKFLOW_LABELS.reviewed,
      ], 'changes-requested')).toEqual({
        labelsToAdd: [],
        labelsToRemove: [
          PR_WORKFLOW_LABELS.reviewDone,
          PR_WORKFLOW_LABELS.reviewInProgress,
          LEGACY_PR_WORKFLOW_LABELS.reviewing,
          LEGACY_PR_WORKFLOW_LABELS.reviewed,
        ],
      });
    });
  });
});
