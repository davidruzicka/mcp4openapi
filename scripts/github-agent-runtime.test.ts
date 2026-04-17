import { describe, expect, it } from 'vitest';
import {
  createReviewThreadReply,
  deleteIssueComment,
  listIssueComments,
  listOpenPullRequests,
  listRecentIssues,
  mapIssueSummaryToProposalCandidate,
  mapPullRequestSummaryToProposalCandidate,
  readIssueRuntimeConfig,
} from './github-agent-runtime.js';

describe('github-agent-runtime config', () => {
  it('prefers MAX_CANDIDATES and falls back to legacy proposal-intake bounds without exposing maxItems', () => {
    const defaults = {
      lookbackHours: 72,
      maxCandidates: 10,
      agentId: 'proposal-intake',
    };

    expect(readIssueRuntimeConfig({
      GITHUB_REPOSITORY: 'davidruzicka/mcp4openapi',
      GITHUB_TOKEN: 'token',
      PROPOSAL_INTAKE_MAX_CANDIDATES: '7',
      PROPOSAL_INTAKE_MAX_ISSUES: '8',
      PROPOSAL_INTAKE_MAX_ITEMS: '9',
    }, 'PROPOSAL_INTAKE', defaults)).toMatchObject({ maxCandidates: 7 });

    expect(readIssueRuntimeConfig({
      GITHUB_REPOSITORY: 'davidruzicka/mcp4openapi',
      GITHUB_TOKEN: 'token',
      PROPOSAL_INTAKE_MAX_ISSUES: '8',
      PROPOSAL_INTAKE_MAX_ITEMS: '9',
    }, 'PROPOSAL_INTAKE', defaults)).toMatchObject({ maxCandidates: 8 });

    expect(readIssueRuntimeConfig({
      GITHUB_REPOSITORY: 'davidruzicka/mcp4openapi',
      GITHUB_TOKEN: 'token',
      PROPOSAL_INTAKE_MAX_ITEMS: '9',
    }, 'PROPOSAL_INTAKE', defaults)).toMatchObject({ maxCandidates: 9 });

    const runtimeConfig = readIssueRuntimeConfig({
      GITHUB_REPOSITORY: 'davidruzicka/mcp4openapi',
      GITHUB_TOKEN: 'token',
    }, 'PROPOSAL_INTAKE', defaults);

    expect(runtimeConfig).toMatchObject({ maxCandidates: 10 });
    expect(runtimeConfig).not.toHaveProperty('maxItems');
  });

  it('reads a semantic duplicate backend override from the stage-specific environment', () => {
    const defaults = {
      lookbackHours: 72,
      maxCandidates: 10,
      agentId: 'issuer',
    };

    expect(readIssueRuntimeConfig({
      GITHUB_REPOSITORY: 'davidruzicka/mcp4openapi',
      GITHUB_TOKEN: 'token',
      ISSUER_SEMANTIC_DUPLICATE_BACKEND: 'disabled',
    }, 'ISSUER', defaults)).toMatchObject({ semanticDuplicateBackendName: 'disabled' });
  });

  it('rejects invalid semantic duplicate backend overrides', () => {
    const defaults = {
      lookbackHours: 72,
      maxCandidates: 10,
      agentId: 'planner',
    };

    expect(() => readIssueRuntimeConfig({
      GITHUB_REPOSITORY: 'davidruzicka/mcp4openapi',
      GITHUB_TOKEN: 'token',
      PLANNER_SEMANTIC_DUPLICATE_BACKEND: 'remote-llm-v1',
    }, 'PLANNER', defaults)).toThrow(
      'Invalid PLANNER_SEMANTIC_DUPLICATE_BACKEND environment variable: expected one of disabled, exact-title-fallback, local-heuristic-v1.',
    );
  });
});

describe('github-agent-runtime listing bounds', () => {
  it('uses maxCandidates to cap recent issue retrieval', async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify([
      {
        number: 11,
        title: 'Newest issue',
        body: null,
        html_url: 'https://github.com/davidruzicka/mcp4openapi/issues/11',
        updated_at: '2026-03-17T10:00:00.000Z',
      },
      {
        number: 10,
        title: 'Second issue',
        body: null,
        html_url: 'https://github.com/davidruzicka/mcp4openapi/issues/10',
        updated_at: '2026-03-17T09:00:00.000Z',
      },
      {
        number: 9,
        title: 'Older issue',
        body: null,
        html_url: 'https://github.com/davidruzicka/mcp4openapi/issues/9',
        updated_at: '2026-03-17T08:00:00.000Z',
      },
    ]), { status: 200 });

    try {
      await expect(listRecentIssues({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'proposal-intake',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      })).resolves.toMatchObject([{ number: 11 }, { number: 10 }]);
    } finally {
      globalThis.fetch = fetchMock;
    }
  });

  it('uses maxCandidates to cap recent pull request retrieval', async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify([
      {
        number: 21,
        title: 'Newest PR',
        body: null,
        html_url: 'https://github.com/davidruzicka/mcp4openapi/pull/21',
        draft: false,
        updated_at: '2026-03-17T10:00:00.000Z',
        state: 'open',
        head: { sha: 'sha-21', ref: 'feat/newest' },
      },
      {
        number: 20,
        title: 'Second PR',
        body: null,
        html_url: 'https://github.com/davidruzicka/mcp4openapi/pull/20',
        draft: false,
        updated_at: '2026-03-17T09:00:00.000Z',
        state: 'open',
        head: { sha: 'sha-20', ref: 'feat/second' },
      },
      {
        number: 19,
        title: 'Older PR',
        body: null,
        html_url: 'https://github.com/davidruzicka/mcp4openapi/pull/19',
        draft: false,
        updated_at: '2026-03-17T08:00:00.000Z',
        state: 'open',
        head: { sha: 'sha-19', ref: 'feat/older' },
      },
    ]), { status: 200 });

    try {
      await expect(listOpenPullRequests({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'proposal-intake',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      })).resolves.toMatchObject([{ number: 21 }, { number: 20 }]);
    } finally {
      globalThis.fetch = fetchMock;
    }
  });
});

describe('github-agent-runtime issue comment listing', () => {
  it('stops after the first page by default', async () => {
    const fetchMock = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify([{ id: 101 }, { id: 102 }]), {
        status: 200,
        headers: {
          link: '<https://api.github.com/repos/davidruzicka/mcp4openapi/issues/251/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/davidruzicka/mcp4openapi/issues/251/comments?per_page=100&page=2>; rel="last"',
        },
      });
    };

    try {
      await expect(listIssueComments({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'implementor',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      }, 251)).resolves.toEqual([{ id: 101 }, { id: 102 }]);
    } finally {
      globalThis.fetch = fetchMock;
    }

    expect(requests).toEqual([
      'https://api.github.com/repos/davidruzicka/mcp4openapi/issues/251/comments?per_page=100',
    ]);
  });

  it('follows pagination links when explicitly allowed', async () => {
    const fetchMock = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      if (requests.length === 1) {
        return new Response(JSON.stringify([{ id: 101 }, { id: 102 }]), {
          status: 200,
          headers: {
            link: '<https://api.github.com/repos/davidruzicka/mcp4openapi/issues/251/comments?per_page=100&page=2>; rel="next", <https://api.github.com/repos/davidruzicka/mcp4openapi/issues/251/comments?per_page=100&page=2>; rel="last"',
          },
        });
      }

      return new Response(JSON.stringify([{ id: 103 }]), { status: 200 });
    };

    try {
      await expect(listIssueComments({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'implementor',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      }, 251, { maxPages: undefined })).resolves.toEqual([{ id: 101 }, { id: 102 }, { id: 103 }]);
    } finally {
      globalThis.fetch = fetchMock;
    }

    expect(requests).toEqual([
      'https://api.github.com/repos/davidruzicka/mcp4openapi/issues/251/comments?per_page=100',
      'https://api.github.com/repos/davidruzicka/mcp4openapi/issues/251/comments?per_page=100&page=2',
    ]);
  });

  it('rejects pagination links that escape the configured API base URL', async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify([{ id: 101 }]), {
      status: 200,
      headers: {
        link: '<https://evil.example/repos/davidruzicka/mcp4openapi/issues/251/comments?page=2>; rel="next"',
      },
    });

    try {
      await expect(listIssueComments({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'implementor',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      }, 251, { maxPages: undefined })).rejects.toThrow('GitHub pagination link escaped API base URL');
    } finally {
      globalThis.fetch = fetchMock;
    }
  });
});

describe('github-agent-runtime comment deletion', () => {
  it('ignores 404 responses when deleting issue comments', async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });

    try {
      await expect(deleteIssueComment({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'implementor',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      }, 12345)).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = fetchMock;
    }
  });

  it('rethrows non-404 deletion failures', async () => {
    const fetchMock = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Internal Server Error' }), { status: 500 });

    try {
      await expect(deleteIssueComment({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'implementor',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      }, 12345)).rejects.toThrow('GitHub API request failed (500) for /repos/davidruzicka/mcp4openapi/issues/comments/12345');
    } finally {
      globalThis.fetch = fetchMock;
    }
  });
});

describe('github-agent-runtime review thread replies', () => {
  it('sends the expected GraphQL payload for review-thread replies', async () => {
    const fetchMock = globalThis.fetch;
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: String(init?.body ?? '') });
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          data: { repository: { pullRequest: { id: 'PR_node_123' } } },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: 'comment-1' } } } }), { status: 200 });
    };

    try {
      await createReviewThreadReply({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'implementor',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      }, {
        pullRequestNumber: 201,
        threadId: 'THREAD_node_456',
        inReplyToCommentId: 'COMMENT_node_789',
        body: 'This reply was prepared by an agent.',
      });
    } finally {
      globalThis.fetch = fetchMock;
    }

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain('/graphql');
    expect(requests[1]?.body).toContain('addPullRequestReviewThreadReply');
    expect(requests[1]?.body).toContain('COMMENT_node_789');
    expect(requests[1]?.body).not.toContain('THREAD_node_456');
  });

  it('throws a clear error when the GraphQL mutation returns errors', async () => {
    const fetchMock = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { repository: { pullRequest: { id: 'PR_node_123' } } },
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        errors: [{ message: 'mutation failed' }],
      }), { status: 200 });
    };

    try {
      await expect(createReviewThreadReply({
        repository: 'davidruzicka/mcp4openapi',
        token: 'token',
        apiBaseUrl: 'https://api.github.com',
        lookbackHours: 48,
        maxCandidates: 2,
        agentId: 'implementor',
        runId: 'manual-test',
        now: '2026-03-17T12:00:00.000Z',
      }, {
        pullRequestNumber: 201,
        threadId: 'THREAD_node_456',
        inReplyToCommentId: 'COMMENT_node_789',
        body: 'This reply was prepared by an agent.',
      })).rejects.toThrow('GitHub GraphQL request failed for review-thread reply: mutation failed');
    } finally {
      globalThis.fetch = fetchMock;
    }
  });
});

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
