import { describe, expect, it } from 'vitest';
import {
  buildSemanticTriagePromptContract,
  findSemanticOpenDuplicate,
  rankSemanticCandidates,
  validateSemanticBackendDecision,
  type SemanticBackendRawDecision,
  type SemanticTriageCandidate,
} from './semantic-triage.js';

function buildCandidate(overrides: Partial<SemanticTriageCandidate> = {}): SemanticTriageCandidate {
  return {
    number: 155,
    title: 'Add bounded cache invalidation metrics for response cache',
    body: [
      '## Summary',
      'Add a narrow metrics hook for cache invalidation counts.',
      '',
      '## Acceptance Criteria',
      '- [ ] expose invalidation counter',
      '- [ ] add targeted unit tests',
    ].join('\n'),
    url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
    labels: ['agent:safe', 'agent:needs-plan'],
    ...overrides,
  };
}

describe('semantic-triage', () => {
  it('keeps exact-title fallback ahead of semantic backends', () => {
    const duplicate = findSemanticOpenDuplicate({
      stage: 'issuer',
      issue: buildCandidate({ number: 160 }),
      candidates: [
        buildCandidate(),
        buildCandidate({
          number: 154,
          title: 'Add bounded invalidation metrics for response cache flushes',
          body: 'Near-duplicate body that would otherwise score highly.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/154',
        }),
      ],
    });

    expect(duplicate).toMatchObject({
      issueNumber: 155,
      relation: 'exact-duplicate',
      backendName: 'exact-title-fallback',
    });
  });

  it('finds a near-duplicate via the local heuristic backend', () => {
    const duplicate = findSemanticOpenDuplicate({
      stage: 'issuer',
      issue: buildCandidate({ number: 160, title: 'Add deterministic invalidation metrics for cache flushes' }),
      candidates: [buildCandidate()],
    });

    expect(duplicate).toMatchObject({
      issueNumber: 155,
      relation: 'near-duplicate',
      backendName: 'local-heuristic-v1',
    });
  });

  it('does not classify merely related issues as duplicates when title overlap stays weak', () => {
    const duplicate = findSemanticOpenDuplicate({
      stage: 'planner',
      issue: buildCandidate({
        number: 170,
        title: 'Document cache invalidation rollout notes',
        body: [
          '## Summary',
          'Document the rollout and incident notes for cache invalidation metrics.',
          '',
          '## Acceptance Criteria',
          '- [ ] add rollout notes',
          '- [ ] explain operator expectations',
        ].join('\n'),
      }),
      candidates: [buildCandidate()],
    });

    expect(duplicate).toBeNull();
  });

  it('does not classify templated docs and tests issues as duplicates when only boilerplate overlaps', () => {
    const templatedBody = (summary: string, acceptance: readonly string[]) => [
      '## Summary',
      summary,
      '',
      '## Acceptance Criteria',
      ...acceptance.map((item) => `- [ ] ${item}`),
      '',
      '## Validation',
      '- [ ] npm test',
      '- [ ] npm run typecheck',
    ].join('\n');

    const duplicate = findSemanticOpenDuplicate({
      stage: 'planner',
      issue: buildCandidate({
        number: 171,
        title: 'Add OAuth callback docs',
        body: templatedBody('Document the OAuth callback flow for operators.', [
          'describe the OAuth callback route',
          'document troubleshooting notes',
        ]),
      }),
      candidates: [buildCandidate({
        number: 170,
        title: 'Add OAuth callback tests',
        body: templatedBody('Add targeted coverage for the OAuth callback flow.', [
          'cover success redirect handling',
          'cover invalid state rejection',
        ]),
      })],
    });

    expect(duplicate).toBeNull();
  });

  it('returns null when two near-duplicate candidates stay ambiguous', () => {
    const issue = buildCandidate({
      number: 170,
      title: 'Add deterministic cache invalidation metrics for response cache flushes',
      body: [
        '## Summary',
        'Add targeted metrics for cache invalidation counts across response cache flush paths and bounded tests.',
        '',
        '## Acceptance Criteria',
        '- [ ] expose invalidation counter',
        '- [ ] add targeted unit tests for flush paths',
      ].join('\n'),
    });

    const duplicate = findSemanticOpenDuplicate({
      stage: 'planner',
      issue,
      candidates: [
        buildCandidate({
          number: 154,
          title: 'Add deterministic cache invalidation metrics refreshes',
          body: 'Document operator guidance for cache invalidation rollout and tests.',
          url: 'https://github.com/davidruzicka/mcp4openapi/issues/154',
        }),
        buildCandidate({
          number: 155,
          title: 'Add deterministic cache invalidation metrics invalidations',
          body: 'Document operator guidance for cache invalidation rollout and tests.',
        }),
      ],
    });

    expect(duplicate).toBeNull();
  });

  it('keeps exact-title duplicate detection available when semantic backends are disabled', () => {
    const duplicate = findSemanticOpenDuplicate({
      stage: 'planner',
      issue: buildCandidate({ number: 160 }),
      candidates: [buildCandidate()],
      backendName: 'disabled',
    });

    expect(duplicate).toMatchObject({
      issueNumber: 155,
      relation: 'exact-duplicate',
      backendName: 'exact-title-fallback',
    });
  });

  it('ranks semantic candidates before applying the bounded prompt cap', () => {
    const issue = buildCandidate({
      number: 210,
      title: 'Add deterministic invalidation metrics for cache flushes',
      body: [
        '## Summary',
        'Add a narrow metrics hook for cache invalidation counts and cache flush paths.',
        '',
        '## Acceptance Criteria',
        '- [ ] expose invalidation counter',
        '- [ ] add targeted unit tests for flush paths',
      ].join('\n'),
    });
    const lowSignalCandidates = Array.from({ length: 8 }, (_, index) => buildCandidate({
      number: 190 + index,
      title: `Related cache work item ${index + 1}`,
      body: 'Mentions cache work broadly without matching the same invalidation metric request.',
      url: `https://github.com/davidruzicka/mcp4openapi/issues/${190 + index}`,
    }));
    const bestCandidate = buildCandidate({
      number: 155,
      title: 'Add deterministic invalidation metrics for cache flushes and response cache',
      body: issue.body,
    });
    const candidates = [...lowSignalCandidates, bestCandidate];

    const ranked = rankSemanticCandidates(issue, candidates);
    const contract = buildSemanticTriagePromptContract({
      stage: 'issuer',
      issue,
      candidates,
    });
    const duplicate = findSemanticOpenDuplicate({
      stage: 'issuer',
      issue,
      candidates,
    });

    expect(ranked[0]?.number).toBe(155);
    expect(contract.candidates).toHaveLength(8);
    expect(contract.candidates.some((candidate) => candidate.number === 155)).toBe(true);
    expect(duplicate).toMatchObject({ issueNumber: 155, backendName: 'local-heuristic-v1' });
  });

  it('rejects invalid backend decisions that point outside the ranked candidate set', () => {
    const decision: SemanticBackendRawDecision = {
      issueNumber: 999,
      relation: 'near-duplicate',
      reason: 'invalid candidate',
      score: 0.8,
    };

    expect(validateSemanticBackendDecision({
      backendName: 'local-heuristic-v1',
      decision,
      candidates: [buildCandidate()],
    })).toBeNull();
  });

  it('rejects ambiguous backend decisions with non-finite scores', () => {
    const decision: SemanticBackendRawDecision = {
      issueNumber: 155,
      relation: 'near-duplicate',
      reason: 'ambiguous score',
      score: Number.NaN,
    };

    expect(validateSemanticBackendDecision({
      backendName: 'local-heuristic-v1',
      decision,
      candidates: [buildCandidate()],
    })).toBeNull();
  });

  it('rejects backend decisions with blank reasons or unsupported relations', () => {
    expect(validateSemanticBackendDecision({
      backendName: 'local-heuristic-v1',
      decision: {
        issueNumber: 155,
        relation: 'near-duplicate',
        reason: '   ',
        score: 0.8,
      },
      candidates: [buildCandidate()],
    })).toBeNull();

    expect(validateSemanticBackendDecision({
      backendName: 'local-heuristic-v1',
      decision: {
        issueNumber: 155,
        relation: 'unsupported' as SemanticBackendRawDecision['relation'],
        reason: 'bad relation',
        score: 0.8,
      },
      candidates: [buildCandidate()],
    })).toBeNull();
  });

  it('breaks ranking ties by title overlap, then body overlap, then earliest issue number', () => {
    const issue = buildCandidate({
      number: 210,
      title: 'cache invalidation metrics flushes',
      body: 'cache invalidation metrics flush paths targeted tests',
    });

    const rankedByTitle = rankSemanticCandidates(issue, [
      buildCandidate({
        number: 157,
        title: 'cache invalidation rollout notes flushes',
        body: issue.body,
      }),
      buildCandidate({
        number: 156,
        title: 'cache invalidation metrics flushes',
        body: 'cache invalidation rollout notes',
      }),
    ]);
    expect(rankedByTitle.map((candidate) => candidate.number)).toEqual([156, 157]);

    const rankedByBodyThenNumber = rankSemanticCandidates(issue, [
      buildCandidate({
        number: 159,
        title: 'cache invalidation metrics flushes',
        body: 'cache invalidation metrics flush paths',
      }),
      buildCandidate({
        number: 158,
        title: 'cache invalidation metrics flushes',
        body: 'cache invalidation metrics flush paths',
      }),
      buildCandidate({
        number: 160,
        title: 'cache invalidation metrics flushes',
        body: 'cache invalidation rollout notes',
      }),
    ]);
    expect(rankedByBodyThenNumber.map((candidate) => candidate.number)).toEqual([158, 159, 160]);
  });

  it('handles empty token sets without treating punctuation-only text as a duplicate', () => {
    const issue = buildCandidate({ number: 210, title: '!!!', body: 'and the for with to' });
    const candidate = buildCandidate({ number: 211, title: '???', body: 'and the for with to' });

    expect(rankSemanticCandidates(issue, [candidate])).toEqual([candidate]);
    expect(findSemanticOpenDuplicate({
      stage: 'issuer',
      issue,
      candidates: [candidate],
    })).toBeNull();
  });

  it('breaks ambiguous local-heuristic ties by earliest matching issue number', () => {
    const duplicate = findSemanticOpenDuplicate({
      stage: 'planner',
      issue: buildCandidate({
        number: 210,
        title: 'cache invalidation metrics for flush paths',
        body: 'cache invalidation metrics flush paths targeted tests and docs',
      }),
      candidates: [
        buildCandidate({
          number: 154,
          title: 'cache invalidation metrics across flush paths',
          body: 'cache invalidation metrics flush paths targeted tests and docs',
        }),
        buildCandidate({
          number: 155,
          title: 'cache invalidation metrics around flush paths',
          body: 'cache invalidation metrics flush paths targeted tests and docs',
        }),
      ],
    });

    expect(duplicate).toMatchObject({
      issueNumber: 154,
      relation: 'near-duplicate',
      backendName: 'local-heuristic-v1',
    });
  });

  it('builds bounded prompt contracts with explicit fallback guardrails from ranked candidates', () => {
    const contract = buildSemanticTriagePromptContract({
      stage: 'issuer',
      issue: buildCandidate({ number: 170, title: 'x'.repeat(400), body: 'y'.repeat(5000) }),
      candidates: [
        buildCandidate(),
        buildCandidate({ number: 156, title: 'Another candidate', body: 'z'.repeat(5000) }),
      ],
    });

    expect(contract.stage).toBe('issuer');
    expect(contract.backendName).toBe('local-heuristic-v1');
    expect(contract.fallback).toContain('Exact-title duplicates remain a required minimum fallback');
    expect(contract.issue.title.length).toBeLessThanOrEqual(160);
    expect(contract.issue.body.length).toBeLessThanOrEqual(1200);
    expect(contract.candidates).toHaveLength(2);
    expect(contract.candidates[0]?.body.length).toBeLessThanOrEqual(1200);
  });
});
