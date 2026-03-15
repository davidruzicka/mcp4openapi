import { buildIssueTitleKey } from './issue-title-key.js';

export type ProposalMatchRelation = 'exact-duplicate' | 'near-duplicate' | 'related-follow-up' | 'regression';
export type ProposalArtifactKind = 'issue' | 'pull_request';
export type ProposalArtifactState = 'open' | 'closed';
export type ProposalWorkflowState = 'candidate' | 'needs-plan' | 'planned' | 'implementing' | 'blocked' | 'merged' | 'unknown';
export type ProposalResolutionAction = 'reject-as-duplicate' | 'comment-existing' | 'create-and-link' | 'create-fresh' | 'no-action';

export interface ProposalCandidateMatch {
  readonly number: number;
  readonly kind: ProposalArtifactKind;
  readonly state: ProposalArtifactState;
  readonly workflowState: ProposalWorkflowState;
  readonly relation: ProposalMatchRelation;
  readonly title: string;
  readonly url: string;
}

export interface ProposalCandidateArtifact {
  readonly number: number;
  readonly kind: ProposalArtifactKind;
  readonly state: ProposalArtifactState;
  readonly workflowState: ProposalWorkflowState;
  readonly title: string;
  readonly body: string;
  readonly url: string;
}

export interface PlanProposalResolutionInput {
  readonly proposalTitle: string;
  readonly matches: readonly ProposalCandidateMatch[];
}

export interface ProposalResolution {
  readonly action: ProposalResolutionAction;
  readonly proposalKey: string;
  readonly reason: string;
  readonly targetIssueNumber?: number;
}

export interface ClassifyProposalMatchRelationInput {
  readonly proposalTitle: string;
  readonly proposalBody: string;
  readonly candidateTitle: string;
  readonly candidateBody: string;
  readonly candidateState: ProposalArtifactState;
}

export interface RankProposalCandidateMatchesInput {
  readonly proposalNumber: number;
  readonly proposalTitle: string;
  readonly proposalBody: string;
  readonly candidates: readonly ProposalCandidateArtifact[];
  readonly maxMatches: number;
}

const PRE_IMPLEMENTATION_WORKFLOW_STATES: readonly ProposalWorkflowState[] = ['candidate', 'needs-plan', 'blocked', 'unknown'];
const ACTIVE_WORKFLOW_STATES: readonly ProposalWorkflowState[] = ['planned', 'implementing', 'merged'];
const DUPLICATE_RELATIONS: readonly ProposalMatchRelation[] = ['exact-duplicate', 'near-duplicate'];
const FOLLOW_UP_MARKERS = ['follow-up', 'follow up', 'extend', 'additional', 'warning threshold', 'budget warning'];
const REGRESSION_MARKERS = ['regression', 'broke', 'broken', 'stopped', 'fails', 'failing', 'again'];
const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'for', 'with', 'to', 'of', 'in', 'on', 'after', 'before', 'need', 'needs', 'add']);
const RELATION_PRIORITY: Readonly<Record<ProposalMatchRelation, number>> = {
  regression: 0,
  'related-follow-up': 1,
  'exact-duplicate': 2,
  'near-duplicate': 3,
};

export function buildProposalKey(title: string): string {
  return buildIssueTitleKey(title);
}

export function classifyProposalMatchRelation(input: ClassifyProposalMatchRelationInput): ProposalMatchRelation | null {
  const proposalKey = buildProposalKey(input.proposalTitle);
  const candidateKey = buildProposalKey(input.candidateTitle);
  if (proposalKey && proposalKey === candidateKey) {
    return 'exact-duplicate';
  }

  const proposalText = `${input.proposalTitle}\n${input.proposalBody}`.toLowerCase();
  const candidateText = `${input.candidateTitle}\n${input.candidateBody}`.toLowerCase();
  const similarity = tokenSimilarity(proposalText, candidateText);

  if (input.candidateState === 'closed' && similarity >= 0.15 && includesAny(proposalText, REGRESSION_MARKERS)) {
    return 'regression';
  }

  if (similarity >= 0.15 && (includesAny(proposalText, FOLLOW_UP_MARKERS) || includesAny(candidateText, FOLLOW_UP_MARKERS))) {
    return 'related-follow-up';
  }

  if (similarity >= 0.3) {
    return 'near-duplicate';
  }

  return null;
}

export function rankProposalCandidateMatches(input: RankProposalCandidateMatchesInput): ProposalCandidateMatch[] {
  return input.candidates
    .filter((candidate) => candidate.number !== input.proposalNumber)
    .flatMap((candidate) => {
      const relation = classifyProposalMatchRelation({
        proposalTitle: input.proposalTitle,
        proposalBody: input.proposalBody,
        candidateTitle: candidate.title,
        candidateBody: candidate.body,
        candidateState: candidate.state,
      });
      if (!relation) {
        return [];
      }

      return [{
        number: candidate.number,
        kind: candidate.kind,
        state: candidate.state,
        workflowState: candidate.workflowState,
        relation,
        title: candidate.title,
        url: candidate.url,
      } satisfies ProposalCandidateMatch];
    })
    .sort((left, right) => {
      const relationDelta = RELATION_PRIORITY[left.relation] - RELATION_PRIORITY[right.relation];
      if (relationDelta !== 0) {
        return relationDelta;
      }

      return left.number - right.number;
    })
    .slice(0, input.maxMatches);
}

export function planProposalResolution(input: PlanProposalResolutionInput): ProposalResolution {
  const proposalKey = buildProposalKey(input.proposalTitle);
  if (hasCompetingMatches(input.matches)) {
    return {
      action: 'no-action',
      proposalKey,
      reason: 'multiple competing matches require human clarification before acting',
    };
  }

  const relevantMatches = input.matches.filter((match) => match.relation !== 'related-follow-up');
  const bestMatch = relevantMatches[0];
  if (!bestMatch) {
    return {
      action: 'create-fresh',
      proposalKey,
      reason: 'no relevant existing issue or pull request matches this proposal',
    };
  }

  if (bestMatch.state === 'open' && DUPLICATE_RELATIONS.includes(bestMatch.relation)) {
    if (PRE_IMPLEMENTATION_WORKFLOW_STATES.includes(bestMatch.workflowState)) {
      return {
        action: 'comment-existing',
        proposalKey,
        reason: 'open pre-implementation issue already tracks the same work',
        targetIssueNumber: bestMatch.number,
      };
    }

    if (ACTIVE_WORKFLOW_STATES.includes(bestMatch.workflowState)) {
      return {
        action: 'create-and-link',
        proposalKey,
        reason: 'existing open work is already active, so a fresh linked follow-up is safer',
        targetIssueNumber: bestMatch.number,
      };
    }
  }

  if (bestMatch.state === 'closed') {
    if (bestMatch.relation === 'regression' || bestMatch.relation === 'related-follow-up') {
      return {
        action: 'create-and-link',
        proposalKey,
        reason: 'closed work only supports a linked regression or follow-up issue',
        targetIssueNumber: bestMatch.number,
      };
    }

    return {
      action: 'reject-as-duplicate',
      proposalKey,
      reason: 'closed exact duplicate does not justify a fresh issue',
      targetIssueNumber: bestMatch.number,
    };
  }

  return {
    action: 'create-fresh',
    proposalKey,
    reason: 'no relevant existing issue or pull request matches this proposal',
  };
}

function hasCompetingMatches(matches: readonly ProposalCandidateMatch[]): boolean {
  if (matches.length <= 1) {
    return false;
  }

  const firstRelation = matches[0]?.relation;
  return matches.some((match) => match.relation !== firstRelation);
}

function includesAny(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const intersectionSize = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersectionSize / Math.min(leftTokens.size, rightTokens.size);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 && !STOP_WORDS.has(token)),
  );
}
