import { describe, expect, it } from 'vitest';
import {
  mapIssueSummaryToProposalCandidate,
  mapPullRequestSummaryToProposalCandidate,
} from './github-agent-runtime.js';

describe('github-agent-runtime proposal candidate mapping', () => {
  it('maps issue workflow labels into proposal candidate artifacts', () => {
    expect(mapIssueSummaryToProposalCandidate({
      number: 155,
      title: 'Add bounded cache invalidation metrics for response cache',
      body: 'Add narrow metrics and targeted tests.',
      html_url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
      updated_at: '2026-03-15T10:00:00Z',
      labels: [{ name: 'agent:safe' }, { name: 'agent:planned' }],
    })).toEqual({
      number: 155,
      kind: 'issue',
      state: 'open',
      workflowState: 'planned',
      title: 'Add bounded cache invalidation metrics for response cache',
      body: 'Add narrow metrics and targeted tests.',
      url: 'https://github.com/davidruzicka/mcp4openapi/issues/155',
    });
  });

  it('maps open and merged pull requests into active proposal candidate artifacts', () => {
    expect(mapPullRequestSummaryToProposalCandidate({
      number: 188,
      title: 'feat: add bounded cache invalidation metrics',
      body: 'Closes #155',
      html_url: 'https://github.com/davidruzicka/mcp4openapi/pull/188',
      draft: false,
      updated_at: '2026-03-15T10:00:00Z',
      state: 'open',
      labels: [{ name: 'agent:review:required' }],
      head: { sha: 'abc123', ref: 'feat/cache-metrics' },
      merged_at: null,
    })).toEqual({
      number: 188,
      kind: 'pull_request',
      state: 'open',
      workflowState: 'implementing',
      title: 'feat: add bounded cache invalidation metrics',
      body: 'Closes #155',
      url: 'https://github.com/davidruzicka/mcp4openapi/pull/188',
    });

    expect(mapPullRequestSummaryToProposalCandidate({
      number: 189,
      title: 'feat: add bounded cache invalidation metrics',
      body: 'Closes #155',
      html_url: 'https://github.com/davidruzicka/mcp4openapi/pull/189',
      draft: false,
      updated_at: '2026-03-15T10:00:00Z',
      state: 'closed',
      labels: [],
      head: { sha: 'def456', ref: 'feat/cache-metrics-merged' },
      merged_at: '2026-03-15T09:00:00Z',
    })).toEqual({
      number: 189,
      kind: 'pull_request',
      state: 'closed',
      workflowState: 'merged',
      title: 'feat: add bounded cache invalidation metrics',
      body: 'Closes #155',
      url: 'https://github.com/davidruzicka/mcp4openapi/pull/189',
    });
  });
});
