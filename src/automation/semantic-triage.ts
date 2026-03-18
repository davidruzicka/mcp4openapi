import { buildIssueTitleKey } from './issue-title-key.js';

export type SemanticTriageStage = 'issuer' | 'planner';
export type SemanticDuplicateRelation = 'exact-duplicate' | 'near-duplicate';
export type SemanticDuplicateBackendName = 'disabled' | 'exact-title-fallback' | 'local-heuristic-v1';

export interface SemanticTriageCandidate {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly labels: readonly string[];
}

export interface SemanticOpenDuplicate {
  readonly issueNumber: number;
  readonly relation: SemanticDuplicateRelation;
  readonly backendName: Exclude<SemanticDuplicateBackendName, 'disabled'>;
  readonly reason: string;
  readonly score: number;
}

export interface SemanticPromptContract {
  readonly stage: SemanticTriageStage;
  readonly backendName: 'local-heuristic-v1';
  readonly fallback: string;
  readonly issue: { readonly number: number; readonly title: string; readonly body: string };
  readonly candidates: ReadonlyArray<{ readonly number: number; readonly title: string; readonly body: string }>;
}

export interface SemanticBackendRawDecision {
  readonly issueNumber: number;
  readonly relation: SemanticDuplicateRelation;
  readonly reason: string;
  readonly score: number;
}

export interface SemanticBackendDecisionValidationInput {
  readonly backendName: Exclude<SemanticDuplicateBackendName, 'disabled' | 'exact-title-fallback'>;
  readonly decision: SemanticBackendRawDecision | null;
  readonly candidates: readonly SemanticTriageCandidate[];
}

export interface SemanticDuplicateBackendContext {
  readonly stage: SemanticTriageStage;
  readonly issue: SemanticTriageCandidate;
  readonly candidates: readonly SemanticTriageCandidate[];
  readonly contract: SemanticPromptContract;
}

export interface SemanticDuplicateBackend {
  readonly name: Exclude<SemanticDuplicateBackendName, 'disabled' | 'exact-title-fallback'>;
  findDuplicate(context: SemanticDuplicateBackendContext): SemanticBackendRawDecision | null;
}

export interface FindSemanticOpenDuplicateInput {
  readonly stage: SemanticTriageStage;
  readonly issue: SemanticTriageCandidate;
  readonly candidates: readonly SemanticTriageCandidate[];
  readonly backendName?: SemanticDuplicateBackendName;
}

interface SimilarityScores {
  readonly sharedTitleTerms: number;
  readonly titleOverlap: number;
  readonly bodyOverlap: number;
  readonly combinedScore: number;
}

const MAX_PROMPT_TITLE_CHARS = 160;
const MAX_PROMPT_BODY_CHARS = 1200;
const MAX_PROMPT_CANDIDATES = 8;
const MIN_SHARED_TITLE_TERMS = 2;
const MIN_TITLE_OVERLAP = 0.34;
const MIN_COMBINED_DUPLICATE_SCORE = 0.52;
const AMBIGUITY_SCORE_DELTA = 0.05;
const AMBIGUITY_MAX_SCORE = 0.68;
const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'for', 'with', 'to', 'of', 'in', 'on', 'after', 'before', 'need', 'needs', 'add']);

const LOCAL_HEURISTIC_BACKEND: SemanticDuplicateBackend = {
  name: 'local-heuristic-v1',
  findDuplicate: ({ issue, candidates }) => findLocalHeuristicDuplicate(issue, candidates),
};

export const SEMANTIC_DUPLICATE_BACKENDS: Readonly<Record<Exclude<SemanticDuplicateBackendName, 'disabled' | 'exact-title-fallback'>, SemanticDuplicateBackend>> = {
  'local-heuristic-v1': LOCAL_HEURISTIC_BACKEND,
};

export function findSemanticOpenDuplicate(input: FindSemanticOpenDuplicateInput): SemanticOpenDuplicate | null {
  const exactDuplicate = findExactTitleDuplicate(input.issue, input.candidates);
  if (exactDuplicate) {
    return exactDuplicate;
  }

  const backend = resolveSemanticBackend(input.backendName);
  if (!backend) {
    return null;
  }

  const rankedCandidates = rankSemanticCandidates(input.issue, input.candidates);
  const boundedCandidates = rankedCandidates.slice(0, MAX_PROMPT_CANDIDATES);
  if (boundedCandidates.length === 0) {
    return null;
  }

  const contract = buildSemanticTriagePromptContract({
    ...input,
    backendName: backend.name,
    candidates: rankedCandidates,
  });

  return validateSemanticBackendDecision({
    backendName: backend.name,
    decision: backend.findDuplicate({
      stage: input.stage,
      issue: input.issue,
      candidates: boundedCandidates,
      contract,
    }),
    candidates: boundedCandidates,
  });
}

export function buildSemanticTriagePromptContract(input: FindSemanticOpenDuplicateInput): SemanticPromptContract {
  const rankedCandidates = rankSemanticCandidates(input.issue, input.candidates).slice(0, MAX_PROMPT_CANDIDATES);

  return {
    stage: input.stage,
    backendName: 'local-heuristic-v1',
    fallback: 'Exact-title duplicates remain a required minimum fallback even if semantic triage is disabled, unavailable, ambiguous, or returns no match.',
    issue: {
      number: input.issue.number,
      title: truncate(input.issue.title, MAX_PROMPT_TITLE_CHARS),
      body: truncate(input.issue.body, MAX_PROMPT_BODY_CHARS),
    },
    candidates: rankedCandidates.map((candidate) => ({
      number: candidate.number,
      title: truncate(candidate.title, MAX_PROMPT_TITLE_CHARS),
      body: truncate(candidate.body, MAX_PROMPT_BODY_CHARS),
    })),
  };
}

export function rankSemanticCandidates(issue: SemanticTriageCandidate, candidates: readonly SemanticTriageCandidate[]): SemanticTriageCandidate[] {
  return [...candidates]
    .map((candidate) => ({
      candidate,
      scores: computeSimilarityScores(issue, candidate),
    }))
    .sort((left, right) => {
      if (right.scores.combinedScore !== left.scores.combinedScore) {
        return right.scores.combinedScore - left.scores.combinedScore;
      }
      if (right.scores.titleOverlap !== left.scores.titleOverlap) {
        return right.scores.titleOverlap - left.scores.titleOverlap;
      }
      if (right.scores.bodyOverlap !== left.scores.bodyOverlap) {
        return right.scores.bodyOverlap - left.scores.bodyOverlap;
      }
      return left.candidate.number - right.candidate.number;
    })
    .map(({ candidate }) => candidate);
}

export function validateSemanticBackendDecision(input: SemanticBackendDecisionValidationInput): SemanticOpenDuplicate | null {
  const decision = input.decision;
  if (!decision) {
    return null;
  }

  const candidate = input.candidates.find((entry) => entry.number === decision.issueNumber);
  if (!candidate) {
    return null;
  }

  if (!Number.isFinite(decision.score) || decision.score <= 0 || decision.score > 1) {
    return null;
  }

  if (!decision.reason.trim()) {
    return null;
  }

  if (decision.relation !== 'near-duplicate' && decision.relation !== 'exact-duplicate') {
    return null;
  }

  return {
    issueNumber: candidate.number,
    relation: decision.relation,
    backendName: input.backendName,
    reason: decision.reason,
    score: decision.score,
  };
}

export function resolveSemanticBackend(
  backendName: SemanticDuplicateBackendName | undefined,
): SemanticDuplicateBackend | null {
  const effectiveBackendName = backendName ?? 'local-heuristic-v1';
  if (effectiveBackendName === 'disabled' || effectiveBackendName === 'exact-title-fallback') {
    return null;
  }

  return SEMANTIC_DUPLICATE_BACKENDS[effectiveBackendName];
}

function findExactTitleDuplicate(issue: SemanticTriageCandidate, candidates: readonly SemanticTriageCandidate[]): SemanticOpenDuplicate | null {
  const issueKey = buildIssueTitleKey(issue.title);
  if (!issueKey) {
    return null;
  }

  const candidate = candidates.find((entry) => buildIssueTitleKey(entry.title) === issueKey);
  if (!candidate) {
    return null;
  }

  return {
    issueNumber: candidate.number,
    relation: 'exact-duplicate',
    backendName: 'exact-title-fallback',
    reason: `issue appears to duplicate existing open issue #${candidate.number}`,
    score: 1,
  };
}

function findLocalHeuristicDuplicate(issue: SemanticTriageCandidate, candidates: readonly SemanticTriageCandidate[]): SemanticBackendRawDecision | null {
  const matches = candidates
    .map((candidate) => ({
      candidate,
      scores: computeSimilarityScores(issue, candidate),
    }))
    .filter(({ scores }) => isNearDuplicateMatch(scores))
    .sort((left, right) => {
      if (right.scores.combinedScore !== left.scores.combinedScore) {
        return right.scores.combinedScore - left.scores.combinedScore;
      }
      return left.candidate.number - right.candidate.number;
    });

  const bestMatch = matches[0];
  if (!bestMatch) {
    return null;
  }

  const secondMatch = matches[1];
  if (secondMatch && bestMatch.scores.combinedScore - secondMatch.scores.combinedScore < AMBIGUITY_SCORE_DELTA && bestMatch.scores.combinedScore < AMBIGUITY_MAX_SCORE) {
    return null;
  }

  return {
    issueNumber: bestMatch.candidate.number,
    relation: 'near-duplicate',
    reason: `issue appears to semantically duplicate existing open issue #${bestMatch.candidate.number}`,
    score: bestMatch.scores.combinedScore,
  };
}

function computeSimilarityScores(issue: SemanticTriageCandidate, candidate: SemanticTriageCandidate): SimilarityScores {
  const issueTitleTokens = tokenizeTitle(issue.title);
  const candidateTitleTokens = tokenizeTitle(candidate.title);
  const issueBodyTokens = tokenizeBody(issue.body);
  const candidateBodyTokens = tokenizeBody(candidate.body);

  const sharedTitleTerms = countSharedTokens(issueTitleTokens, candidateTitleTokens);
  const titleOverlap = computeTokenOverlap(issueTitleTokens, candidateTitleTokens);
  const bodyOverlap = computeTokenOverlap(issueBodyTokens, candidateBodyTokens);

  return {
    sharedTitleTerms,
    titleOverlap,
    bodyOverlap,
    combinedScore: (titleOverlap * 0.7) + (bodyOverlap * 0.3),
  };
}

function isNearDuplicateMatch(scores: SimilarityScores): boolean {
  return scores.sharedTitleTerms >= MIN_SHARED_TITLE_TERMS
    && scores.titleOverlap >= MIN_TITLE_OVERLAP
    && scores.combinedScore >= MIN_COMBINED_DUPLICATE_SCORE;
}

function computeTokenOverlap(leftTokens: Set<string>, rightTokens: Set<string>): number {
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  const intersectionSize = countSharedTokens(leftTokens, rightTokens);
  return (2 * intersectionSize) / (leftTokens.size + rightTokens.size);
}

function countSharedTokens(leftTokens: Set<string>, rightTokens: Set<string>): number {
  return [...leftTokens].filter((token) => rightTokens.has(token)).length;
}

function tokenizeTitle(text: string): Set<string> {
  return tokenize(text, 4);
}

function tokenizeBody(text: string): Set<string> {
  return tokenize(text, 5);
}

function tokenize(text: string, minLength: number): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= minLength && !STOP_WORDS.has(token)),
  );
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}
