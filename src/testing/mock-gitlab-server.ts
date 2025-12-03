/**
 * Mock GitLab API server for integration testing
 * 
 * Why: Enables end-to-end testing without real GitLab instance.
 * Tests actual HTTP flow, parameter handling, error scenarios.
 */

import { http, HttpResponse, RequestHandler } from 'msw';
import { setupServer, SetupServerApi } from 'msw/node';
import * as fixtures from './fixtures.js';
import {
  parsePaginationParams,
  parseSearchParam,
  parseBranchParams,
  parseScopeParam,
} from './mock-utils.js';

/** Default BASE_URL for GitLab API (used by MSW interceptor) */
export const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4';

/** OAuth mock configuration */
export interface OAuthConfig {
  /** OAuth server base URL (e.g., http://localhost:4000) */
  oauthBaseUrl: string;
  /** Access token returned by token endpoint */
  accessToken?: string;
  /** Refresh token returned by token endpoint */
  refreshToken?: string;
  /** Token expiry in seconds */
  expiresIn?: number;
}

/** Default OAuth config */
const DEFAULT_OAUTH_CONFIG: OAuthConfig = {
  oauthBaseUrl: 'http://localhost:4000',
  accessToken: 'mock-access-token-12345',
  refreshToken: 'mock-refresh-token-67890',
  expiresIn: 3600,
};

type BranchFixture = (typeof fixtures.mockBranchesList)[number];
type BranchState = BranchFixture & {
  developers_can_push?: boolean;
  developers_can_merge?: boolean;
  can_push?: boolean;
  web_url?: string;
};

/**
 * Helper: Extract and validate IID from URL
 * 
 * Why: Prevents path traversal and invalid integer attacks
 * Returns null if invalid (caller should return 400 Bad Request)
 */
function extractIidFromUrl(url: string): number | null {
  const parts = url.split('/');
  const iidStr = parts[parts.length - 1];
  
  if (!iidStr || !/^\d+$/.test(iidStr)) {
    return null;
  }
  
  const iid = parseInt(iidStr, 10);
  if (isNaN(iid) || iid < 1 || iid > 2147483647) {
    return null;
  }
  
  return iid;
}

/**
 * Extract merge request IID from notes URL
 * URL format: /projects/{project}/merge_requests/{iid}/notes
 */
function extractMrIidFromNotesUrl(url: string): number | null {
  const urlWithoutQuery = url.split('?')[0];
  const match = urlWithoutQuery.match(/\/merge_requests\/(\d+)\/notes/);
  if (!match) {
    return null;
  }
  const iid = parseInt(match[1], 10);
  if (isNaN(iid) || iid < 1 || iid > 2147483647) {
    return null;
  }
  return iid;
}

function extractBranchNameFromUrl(url: string): string | null {
  const pathWithoutQuery = url.split('?')[0];
  const match = pathWithoutQuery.match(/\/repository\/branches\/([^\/]+)/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

/**
 * Create OAuth handlers for mock OAuth server
 */
export function createOAuthHandlers(config: OAuthConfig = DEFAULT_OAUTH_CONFIG): RequestHandler[] {
  const { oauthBaseUrl, accessToken, refreshToken, expiresIn } = { ...DEFAULT_OAUTH_CONFIG, ...config };
  
  return [
    // OAuth Discovery endpoint
    http.get(`${oauthBaseUrl}/.well-known/oauth-authorization-server`, () => {
      return HttpResponse.json({
        issuer: oauthBaseUrl,
        authorization_endpoint: `${oauthBaseUrl}/oauth/authorize`,
        token_endpoint: `${oauthBaseUrl}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
    }),

    // OAuth Authorization endpoint - redirects with code
    http.get(`${oauthBaseUrl}/oauth/authorize`, ({ request }) => {
      const url = new URL(request.url);
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');

      if (!redirectUri) {
        return HttpResponse.json({ error: 'missing_redirect_uri' }, { status: 400 });
      }

      const code = 'mock-code-' + Math.random().toString(36).substring(7);
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (state) {
        redirectUrl.searchParams.set('state', state);
      }

      return new HttpResponse(null, {
        status: 302,
        headers: { Location: redirectUrl.toString() },
      });
    }),

    // OAuth Token endpoint
    http.post(`${oauthBaseUrl}/oauth/token`, async ({ request }) => {
      const contentType = request.headers.get('content-type') || '';
      let params: Record<string, string>;
      
      if (contentType.includes('application/json')) {
        params = await request.json() as Record<string, string>;
      } else {
        const body = await request.text();
        params = Object.fromEntries(new URLSearchParams(body));
      }

      const grantType = params.grant_type;

      if (grantType === 'authorization_code') {
        if (!params.code) {
          return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return HttpResponse.json({
          access_token: accessToken,
          refresh_token: refreshToken,
          token_type: 'Bearer',
          expires_in: expiresIn,
          scope: 'api',
        });
      }

      if (grantType === 'refresh_token') {
        if (!params.refresh_token) {
          return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return HttpResponse.json({
          access_token: `${accessToken}-refreshed`,
          refresh_token: `${refreshToken}-new`,
          token_type: 'Bearer',
          expires_in: expiresIn,
          scope: 'api',
        });
      }

      return HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }),
  ];
}

/**
 * Create GitLab API handlers with configurable base URL
 */
export function createGitLabHandlers(baseUrl: string = DEFAULT_BASE_URL): RequestHandler[] {
  const branchStates = new Map<string, BranchState>(
    fixtures.mockBranchesList.map((branch) => [
      branch.name,
      structuredClone(branch) as BranchState,
    ])
  );

  const findBranch = (name: string | null): BranchState | undefined => {
    if (!name) return undefined;
    return branchStates.get(name);
  };

  const listBranches = (): BranchState[] => Array.from(branchStates.values());

  return [
    // Groups
    http.get(`${baseUrl}/groups`, ({ request }) => {
      const { page } = parsePaginationParams(request);
      const search = parseSearchParam(request);
      
      let groups = fixtures.mockGroupsList;
      if (search) {
        groups = groups.filter(g => 
          g.name.toLowerCase().includes(search.toLowerCase()) ||
          g.path.toLowerCase().includes(search.toLowerCase())
        );
      }
      if (page > 1) {
        return HttpResponse.json([]);
      }
      return HttpResponse.json(groups);
    }),

    http.get(`${baseUrl}/groups/:id`, ({ params }) => {
      const groupId = params.id as string;
      if (groupId === '36173' || groupId === 'davidruzicka') {
        return HttpResponse.json(fixtures.mockGroup);
      }
      return HttpResponse.json({ message: 'Group Not Found' }, { status: 404 });
    }),

    http.get(`${baseUrl}/groups/:id/projects`, ({ request, params }) => {
      const groupId = params.id as string;
      const { page } = parsePaginationParams(request);
      
      if (groupId === '36173' || groupId === 'davidruzicka') {
        if (page > 1) {
          return HttpResponse.json([]);
        }
        return HttpResponse.json(fixtures.mockProjectsList);
      }
      return HttpResponse.json({ message: 'Group Not Found' }, { status: 404 });
    }),

    http.get(`${baseUrl}/groups/:id/subgroups`, ({ request, params }) => {
      const groupId = params.id as string;
      const { page } = parsePaginationParams(request);
      
      if (groupId === '36173' || groupId === 'davidruzicka') {
        if (page > 1) {
          return HttpResponse.json([]);
        }
        return HttpResponse.json(fixtures.mockSubgroupsList);
      }
      return HttpResponse.json({ message: 'Group Not Found' }, { status: 404 });
    }),

    // Projects
    http.get(`${baseUrl}/projects`, ({ request }) => {
      const { page } = parsePaginationParams(request);
      const search = parseSearchParam(request);
      
      let projects = fixtures.mockProjectsList;
      if (search) {
        projects = projects.filter(p => 
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.description?.toLowerCase().includes(search.toLowerCase())
        );
      }
      if (page > 1) {
        return HttpResponse.json([]);
      }
      return HttpResponse.json(projects);
    }),

    http.get(`${baseUrl}/projects/:id`, ({ params }) => {
      const projectId = params.id as string;
      if (projectId === '12345' || projectId === 'davidruzicka%2Fmcp4openapi') {
        return HttpResponse.json(fixtures.mockProject);
      }
      return HttpResponse.json({ message: 'Project Not Found' }, { status: 404 });
    }),

    // Project Badges
    http.get(`${baseUrl}/projects/*/badges`, ({ request }) => {
      const { page } = parsePaginationParams(request);
      if (page === 1) {
        return HttpResponse.json(fixtures.mockBadgesList);
      }
      return HttpResponse.json([]);
    }),

    http.get(`${baseUrl}/projects/*/badges/*`, ({ request }) => {
      const badgeId = extractIidFromUrl(request.url);
      if (badgeId === null) {
        return HttpResponse.json({ error: 'Invalid badge ID' }, { status: 400 });
      }
      if (badgeId === 1) {
        return HttpResponse.json(fixtures.mockBadge);
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.post(`${baseUrl}/projects/*/badges`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      
      if (!body.link_url || !body.image_url) {
        return HttpResponse.json(
          { error: 'link_url and image_url are required' },
          { status: 400 }
        );
      }

      return HttpResponse.json({
        ...fixtures.mockBadge,
        id: 3,
        name: body.name || 'New Badge',
        link_url: body.link_url,
        image_url: body.image_url,
      }, { status: 201 });
    }),

    http.put(`${baseUrl}/projects/*/badges/*`, async ({ request }) => {
      const badgeId = extractIidFromUrl(request.url);
      if (badgeId === null) {
        return HttpResponse.json({ error: 'Invalid badge ID' }, { status: 400 });
      }
      const body = await request.json() as Record<string, unknown>;

      if (badgeId === 1) {
        return HttpResponse.json({
          ...fixtures.mockBadge,
          name: body.name || fixtures.mockBadge.name,
          link_url: body.link_url || fixtures.mockBadge.link_url,
          image_url: body.image_url || fixtures.mockBadge.image_url,
        });
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.delete(`${baseUrl}/projects/*/badges/*`, ({ request }) => {
      const badgeId = extractIidFromUrl(request.url);
      if (badgeId === null) {
        return HttpResponse.json({ error: 'Invalid badge ID' }, { status: 400 });
      }
      if (badgeId === 1) {
        return new HttpResponse(null, { status: 204 });
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    // Group Badges
    http.get(`${baseUrl}/groups/*/badges`, () => {
      return HttpResponse.json(fixtures.mockBadgesList);
    }),

    http.post(`${baseUrl}/groups/*/badges`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...fixtures.mockBadge,
        id: 4,
        kind: 'group',
        name: body.name || 'Group Badge',
      }, { status: 201 });
    }),

    // Branches
    http.get(`${baseUrl}/projects/*/repository/branches`, ({ request }) => {
      const search = parseSearchParam(request);
      let branches = listBranches();

      if (search) {
        branches = branches.filter((b) => b.name.includes(search));
      }
      return HttpResponse.json(branches);
    }),

    http.head(`${baseUrl}/projects/*/repository/branches/*`, ({ request }) => {
      const branchName = extractBranchNameFromUrl(request.url);
      const branch = findBranch(branchName);

      if (!branch) {
        return HttpResponse.json({ message: 'Branch Not Found' }, { status: 404 });
      }

      return HttpResponse.json({ exists: true });
    }),

    http.get(`${baseUrl}/projects/*/repository/branches/*`, ({ request }) => {
      const branchName = extractBranchNameFromUrl(request.url);
      const branch = findBranch(branchName);
      
      if (branch) {
        return HttpResponse.json(branch);
      }
      return HttpResponse.json({ message: 'Branch Not Found' }, { status: 404 });
    }),

    http.post(`${baseUrl}/projects/*/repository/branches`, async ({ request }) => {
      const { branch, ref } = parseBranchParams(request);

      if (!branch || !ref) {
        return HttpResponse.json(
          { error: 'branch and ref parameters are required' },
          { status: 400 }
        );
      }

      const baseCommit = structuredClone(fixtures.mockBranch.commit) as Record<string, unknown>;
      const newBranch: BranchState = {
        name: branch,
        commit: {
          ...baseCommit,
          id: `${branch}-${Date.now()}`,
          short_id: `${branch.substring(0, 7)}-new`
        },
        merged: false,
        protected: false,
        default: false,
        can_push: true,
        web_url: `https://gitlab.com/my-org/my-project/-/tree/${encodeURIComponent(branch)}`,
      } as BranchState;

      branchStates.set(branch, newBranch);

      return HttpResponse.json(newBranch, { status: 201 });
    }),

    http.delete(`${baseUrl}/projects/*/repository/branches/*`, ({ request }) => {
      const branchName = extractBranchNameFromUrl(request.url);
      const branch = findBranch(branchName);

      if (!branch) {
        return HttpResponse.json({ message: 'Branch Not Found' }, { status: 404 });
      }

      if (branch.default) {
        return HttpResponse.json(
          { message: 'Cannot delete default branch' },
          { status: 403 }
        );
      }

      branchStates.delete(branchName!);
      return new HttpResponse(null, { status: 204 });
    }),

    http.put(`${baseUrl}/projects/*/repository/branches/*/protect`, async ({ request }) => {
      const branchName = extractBranchNameFromUrl(request.url);
      const branch = findBranch(branchName);

      if (!branch) {
        return HttpResponse.json({ message: 'Branch Not Found' }, { status: 404 });
      }

      const body = await request.json() as Record<string, unknown>;
      branch.protected = true;
      if (typeof body.developers_can_push === 'boolean') {
        branch.developers_can_push = body.developers_can_push;
      }
      if (typeof body.developers_can_merge === 'boolean') {
        branch.developers_can_merge = body.developers_can_merge;
      }
      branchStates.set(branchName!, branch);

      return HttpResponse.json(branch);
    }),

    http.put(`${baseUrl}/projects/*/repository/branches/*/unprotect`, async ({ request }) => {
      const branchName = extractBranchNameFromUrl(request.url);
      const branch = findBranch(branchName);

      if (!branch) {
        return HttpResponse.json({ message: 'Branch Not Found' }, { status: 404 });
      }

      const body = await request.json() as Record<string, unknown>;
      branch.protected = false;
      if (typeof body.developers_can_push === 'boolean') {
        branch.developers_can_push = body.developers_can_push;
      }
      if (typeof body.developers_can_merge === 'boolean') {
        branch.developers_can_merge = body.developers_can_merge;
      }
      branchStates.set(branchName!, branch);

      return HttpResponse.json(branch);
    }),

    // Access Requests
    http.get(`${baseUrl}/projects/*/access_requests`, () => {
      return HttpResponse.json(fixtures.mockAccessRequestsList);
    }),

    http.get(`${baseUrl}/groups/*/access_requests`, () => {
      return HttpResponse.json(fixtures.mockAccessRequestsList);
    }),

    http.post(`${baseUrl}/projects/*/access_requests`, () => {
      return HttpResponse.json(fixtures.mockAccessRequest, { status: 201 });
    }),

    http.put(`${baseUrl}/projects/*/access_requests/*/approve`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      const parts = request.url.split('/');
      const userId = parseInt(parts[parts.length - 2], 10);

      return HttpResponse.json({
        ...fixtures.mockAccessRequest,
        id: userId,
        access_level: body.access_level || 30,
      });
    }),

    http.delete(`${baseUrl}/projects/*/access_requests/*`, () => {
      return new HttpResponse(null, { status: 204 });
    }),

    // Jobs
    http.get(`${baseUrl}/projects/*/jobs`, ({ request }) => {
      const scope = parseScopeParam(request);

      if (scope.length > 0 && scope.includes('failed')) {
        return HttpResponse.json(fixtures.mockJobsList.filter(j => j.status === 'failed'));
      }
      return HttpResponse.json(fixtures.mockJobsList);
    }),

    http.get(`${baseUrl}/projects/*/jobs/*`, ({ request }) => {
      const jobId = extractIidFromUrl(request.url);
      if (jobId === null) {
        return HttpResponse.json({ error: 'Invalid job ID' }, { status: 400 });
      }
      if (jobId === 1234) {
        return HttpResponse.json(fixtures.mockJob);
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.post(`${baseUrl}/projects/*/jobs/*/play`, ({ request }) => {
      const parts = request.url.split('/');
      const jobId = parseInt(parts[parts.length - 2], 10);
      return HttpResponse.json({
        ...fixtures.mockJob,
        id: jobId,
        status: 'pending',
      });
    }),

    // Rate limiting simulation
    http.get(`${baseUrl}/rate-limit-test`, () => {
      return HttpResponse.json(
        { message: 'Rate limit exceeded' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }),

    // Merge Request Notes (MUST be before generic merge_requests/* handlers)
    http.get(`${baseUrl}/projects/*/merge_requests/*/notes`, ({ request }) => {
      let mergeRequestIid = extractMrIidFromNotesUrl(request.url);
      if (mergeRequestIid === null) {
        const decodedUrl = decodeURIComponent(request.url);
        mergeRequestIid = extractMrIidFromNotesUrl(decodedUrl);
      }
      if (mergeRequestIid === null) {
        const altMatch = request.url.match(/merge_requests[\/%2F](\d+)[\/%2F]notes/);
        if (altMatch) {
          mergeRequestIid = parseInt(altMatch[1], 10);
        }
      }
      if (mergeRequestIid === null || isNaN(mergeRequestIid)) {
        return HttpResponse.json({ error: 'Invalid merge request IID' }, { status: 400 });
      }
      if (mergeRequestIid === 1) {
        return HttpResponse.json(fixtures.mockNotesList);
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.post(`${baseUrl}/projects/*/merge_requests/*/notes`, async ({ request }) => {
      let mergeRequestIid = extractMrIidFromNotesUrl(request.url);
      if (mergeRequestIid === null) {
        const decodedUrl = decodeURIComponent(request.url);
        mergeRequestIid = extractMrIidFromNotesUrl(decodedUrl);
      }
      if (mergeRequestIid === null) {
        const altMatch = request.url.match(/merge_requests[\/%2F](\d+)[\/%2F]notes/);
        if (altMatch) {
          mergeRequestIid = parseInt(altMatch[1], 10);
        }
      }
      if (mergeRequestIid === null || isNaN(mergeRequestIid)) {
        return HttpResponse.json({ error: 'Invalid merge request IID' }, { status: 400 });
      }
      const body = await request.json() as Record<string, unknown>;
      if (!body.body) {
        return HttpResponse.json({ error: 'body is required' }, { status: 400 });
      }
      const createdNote = {
        ...fixtures.mockNote,
        id: 3,
        body: body.body as string,
        confidential: body.confidential || false,
        created_at: new Date().toISOString(),
      };
      return HttpResponse.json(createdNote, { status: 201 });
    }),

    http.put(`${baseUrl}/projects/*/merge_requests/*/notes/*`, async ({ request }) => {
      const urlWithoutQuery = request.url.split('?')[0];
      const urlParts = urlWithoutQuery.split('/notes/');
      if (urlParts.length < 2) {
        return HttpResponse.json({ error: 'Invalid note ID' }, { status: 400 });
      }
      const noteIdStr = urlParts[1].split('?')[0].split('/')[0];
      const noteId = parseInt(noteIdStr, 10);
      if (isNaN(noteId)) {
        return HttpResponse.json({ error: 'Invalid note ID' }, { status: 400 });
      }
      if (noteId === 1) {
        const body = await request.json() as Record<string, unknown>;
        if (!body.body) {
          return HttpResponse.json({ error: 'body is required' }, { status: 400 });
        }
        const updatedNote = {
          ...fixtures.mockNote,
          id: noteId,
          body: body.body as string,
          confidential: body.confidential !== undefined ? body.confidential : fixtures.mockNote.confidential,
          updated_at: new Date().toISOString(),
        };
        return HttpResponse.json(updatedNote, { status: 200 });
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.delete(`${baseUrl}/projects/*/merge_requests/*/notes/*`, ({ request }) => {
      const urlParts = request.url.split('/notes/');
      if (urlParts.length < 2) {
        return HttpResponse.json({ error: 'Invalid note ID' }, { status: 400 });
      }
      const noteId = parseInt(urlParts[1], 10);
      if (isNaN(noteId)) {
        return HttpResponse.json({ error: 'Invalid note ID' }, { status: 400 });
      }
      if (noteId === 1) {
        return new HttpResponse(null, { status: 204 });
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    // Merge Requests (generic handlers after more specific /notes handlers)
    http.get(`${baseUrl}/projects/*/merge_requests`, ({ request }) => {
      const { page } = parsePaginationParams(request);
      if (page === 1) {
        return HttpResponse.json(fixtures.mockMergeRequestsList);
      }
      return HttpResponse.json([]);
    }),

    http.get(`${baseUrl}/projects/*/merge_requests/*`, ({ request }) => {
      const mergeRequestIid = extractIidFromUrl(request.url);
      if (mergeRequestIid === null) {
        return HttpResponse.json({ error: 'Invalid merge request IID' }, { status: 400 });
      }
      if (mergeRequestIid === 1) {
        return HttpResponse.json(fixtures.mockMergeRequest);
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.post(`${baseUrl}/projects/*/merge_requests`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;

      if (!body.source_branch || !body.target_branch || !body.title) {
        return HttpResponse.json(
          { error: 'source_branch, target_branch, and title are required' },
          { status: 400 }
        );
      }

      const createdMR = {
        ...fixtures.mockMergeRequest,
        iid: 3,
        id: 3,
        title: body.title,
        source_branch: body.source_branch,
        target_branch: body.target_branch,
        description: body.description,
        web_url: 'https://gitlab.com/my-org/my-project/-/merge_requests/3',
      };

      return HttpResponse.json(createdMR, { status: 201 });
    }),

    http.put(`${baseUrl}/projects/*/merge_requests/*`, async ({ request }) => {
      const mergeRequestIid = extractIidFromUrl(request.url);
      if (mergeRequestIid === null) {
        return HttpResponse.json({ error: 'Invalid merge request IID' }, { status: 400 });
      }
      if (mergeRequestIid === 1) {
        const body = await request.json() as Record<string, unknown>;
        const updatedMR = {
          ...fixtures.mockMergeRequest,
          title: body.title || fixtures.mockMergeRequest.title,
          description: body.description !== undefined ? body.description : fixtures.mockMergeRequest.description,
          state: body.state_event === 'close' ? 'closed' : fixtures.mockMergeRequest.state,
          updated_at: new Date().toISOString(),
        };
        return HttpResponse.json(updatedMR, { status: 200 });
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.delete(`${baseUrl}/projects/*/merge_requests/*`, ({ request }) => {
      if (request.url.includes('/forbidden-project/')) {
        return HttpResponse.json(
          { message: 'Forbidden', error: 'You do not have permission to delete this merge request' },
          { status: 403 }
        );
      }
      
      const mergeRequestIid = extractIidFromUrl(request.url);
      if (mergeRequestIid === null) {
        return HttpResponse.json({ error: 'Invalid merge request IID' }, { status: 400 });
      }
      if (mergeRequestIid === 1) {
        return new HttpResponse(null, { status: 204 });
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    // Issues
    http.get(`${baseUrl}/projects/*/issues`, ({ request }) => {
      const { page } = parsePaginationParams(request);
      if (page === 1) {
        return HttpResponse.json(fixtures.mockIssuesList);
      }
      return HttpResponse.json([]);
    }),

    http.get(`${baseUrl}/projects/*/issues/*`, ({ request }) => {
      const issueIid = extractIidFromUrl(request.url);
      if (issueIid === null) {
        return HttpResponse.json({ error: 'Invalid issue IID' }, { status: 400 });
      }
      if (issueIid === 1) {
        return HttpResponse.json(fixtures.mockIssue);
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    http.post(`${baseUrl}/projects/*/issues`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;

      if (!body.title) {
        return HttpResponse.json({ error: 'title is required' }, { status: 400 });
      }

      const createdIssue = {
        ...fixtures.mockIssue,
        iid: 3,
        id: 3,
        title: body.title as string,
        description: (body.description as string) || '',
        state: 'opened',
        web_url: 'https://gitlab.com/my-org/my-project/-/issues/3',
        created_at: new Date().toISOString(),
      };

      return HttpResponse.json(createdIssue, { status: 201 });
    }),

    http.delete(`${baseUrl}/projects/*/issues/*`, ({ request }) => {
      if (request.url.includes('/forbidden-project/')) {
        return HttpResponse.json(
          { message: 'Forbidden', error: 'You do not have permission to delete this issue' },
          { status: 403 }
        );
      }
      
      const issueIid = extractIidFromUrl(request.url);
      if (issueIid === null) {
        return HttpResponse.json({ error: 'Invalid issue IID' }, { status: 400 });
      }
      if (issueIid === 1) {
        return new HttpResponse(null, { status: 204 });
      }
      return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),

    // Server error simulation
    http.get(`${baseUrl}/server-error-test`, () => {
      return HttpResponse.json(
        { message: 'Internal Server Error' },
        { status: 503 }
      );
    }),
  ];
}

/**
 * Create all handlers (GitLab API + OAuth) with configurable URLs
 */
export function createAllHandlers(
  gitlabBaseUrl: string = DEFAULT_BASE_URL,
  oauthConfig?: OAuthConfig
): RequestHandler[] {
  const gitlabHandlers = createGitLabHandlers(gitlabBaseUrl);
  const oauthHandlers = oauthConfig ? createOAuthHandlers(oauthConfig) : [];
  return [...oauthHandlers, ...gitlabHandlers];
}

// Legacy exports for backward compatibility with existing unit tests
export const handlers: RequestHandler[] = createGitLabHandlers(DEFAULT_BASE_URL);
export const mockServer: SetupServerApi = setupServer(...handlers);

export function startMockServer(): void {
  mockServer.listen({ onUnhandledRequest: 'error' });
}

export function resetMockServer(): void {
  mockServer.resetHandlers();
}

export function stopMockServer(): void {
  mockServer.close();
}

/**
 * Create a new MSW server instance with custom handlers
 */
export function createMockServer(
  gitlabBaseUrl: string = DEFAULT_BASE_URL,
  oauthConfig?: OAuthConfig
): SetupServerApi {
  const allHandlers = createAllHandlers(gitlabBaseUrl, oauthConfig);
  return setupServer(...allHandlers);
}

