/**
 * Mock GitLab API server for integration testing
 * 
 * Why: Enables end-to-end testing without real GitLab instance.
 * Tests actual HTTP flow, parameter handling, error scenarios.
 */

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import * as fixtures from './fixtures.js';
import {
  parsePaginationParams,
  parseSearchParam,
  parseBranchParams,
  parseScopeParam,
  applyPagination
} from './mock-utils.js';

const BASE_URL = 'https://gitlab.com/api/v4';

/**
 * Helper: Extract and validate IID from URL
 * 
 * Why: Prevents path traversal and invalid integer attacks
 * Returns null if invalid (caller should return 400 Bad Request)
 */
function extractIidFromUrl(url: string): number | null {
  const parts = url.split('/');
  const iidStr = parts[parts.length - 1];
  
  // Validate it's a positive integer
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
  // Remove query parameters for matching
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

/**
 * Mock GitLab API endpoints
 * 
 * Why ordered by resource: Mirrors actual GitLab API structure for maintainability
 * Why wildcard patterns: GitLab accepts URL-encoded paths like my-org/my-project
 */
export const handlers = [
  // Project Badges
  http.get(`${BASE_URL}/projects/*/badges`, ({ request, params }) => {
    const { page } = parsePaginationParams(request);

    // Simple pagination
    if (page === 1) {
      return HttpResponse.json(fixtures.mockBadgesList);
    }
    return HttpResponse.json([]);
  }),

  http.get(`${BASE_URL}/projects/*/badges/*`, ({ request }) => {
    const badgeId = extractIidFromUrl(request.url);
    if (badgeId === null) {
      return HttpResponse.json({ error: 'Invalid badge ID' }, { status: 400 });
    }
    if (badgeId === 1) {
      return HttpResponse.json(fixtures.mockBadge);
    }
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),

  http.post(`${BASE_URL}/projects/*/badges`, async ({ request }) => {
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

  http.put(`${BASE_URL}/projects/*/badges/*`, async ({ request }) => {
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

  http.delete(`${BASE_URL}/projects/*/badges/*`, ({ request }) => {
    const badgeId = extractIidFromUrl(request.url);
    if (badgeId === null) {
      return HttpResponse.json({ error: 'Invalid badge ID' }, { status: 400 });
    }
    if (badgeId === 1) {
      return new HttpResponse(null, { status: 204 });
    }
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),

  // Group Badges (similar structure)
  http.get(`${BASE_URL}/groups/*/badges`, () => {
    return HttpResponse.json(fixtures.mockBadgesList);
  }),

  http.post(`${BASE_URL}/groups/*/badges`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      ...fixtures.mockBadge,
      id: 4,
      kind: 'group',
      name: body.name || 'Group Badge',
    }, { status: 201 });
  }),

  // Branches
  http.get(`${BASE_URL}/projects/*/repository/branches`, ({ request }) => {
    const search = parseSearchParam(request);

    if (search) {
      return HttpResponse.json(
        fixtures.mockBranchesList.filter(b => b.name.includes(search))
      );
    }
    return HttpResponse.json(fixtures.mockBranchesList);
  }),

  http.get(`${BASE_URL}/projects/*/repository/branches/*`, ({ request }) => {
    const branch = decodeURIComponent(request.url.split('/').pop() || '');
    const found = fixtures.mockBranchesList.find(b => b.name === branch);
    
    if (found) {
      return HttpResponse.json(found);
    }
    return HttpResponse.json({ message: 'Branch Not Found' }, { status: 404 });
  }),

  http.post(`${BASE_URL}/projects/*/repository/branches`, async ({ request }) => {
    const { branch, ref } = parseBranchParams(request);

    if (!branch || !ref) {
      return HttpResponse.json(
        { error: 'branch and ref parameters are required' },
        { status: 400 }
      );
    }

    return HttpResponse.json({
      name: branch,
      commit: fixtures.mockBranch.commit,
      merged: false,
      protected: false,
      default: false,
    }, { status: 201 });
  }),

  http.delete(`${BASE_URL}/projects/*/repository/branches/*`, ({ request }) => {
    const branch = decodeURIComponent(request.url.split('/').pop() || '');
    if (branch !== 'main') {
      return new HttpResponse(null, { status: 204 });
    }
    return HttpResponse.json(
      { message: 'Cannot delete default branch' },
      { status: 403 }
    );
  }),

  http.put(`${BASE_URL}/projects/*/repository/branches/*/protect`, ({ request }) => {
    const parts = request.url.split('/');
    const branch = decodeURIComponent(parts[parts.length - 2]); // second-to-last part
    return HttpResponse.json({
      ...fixtures.mockBranch,
      name: branch,
      protected: true,
    });
  }),

  http.put(`${BASE_URL}/projects/*/repository/branches/*/unprotect`, ({ request }) => {
    const parts = request.url.split('/');
    const branch = decodeURIComponent(parts[parts.length - 2]); // second-to-last part
    return HttpResponse.json({
      ...fixtures.mockBranch,
      name: branch,
      protected: false,
    });
  }),

  // Access Requests
  http.get(`${BASE_URL}/projects/*/access_requests`, () => {
    return HttpResponse.json(fixtures.mockAccessRequestsList);
  }),

  http.get(`${BASE_URL}/groups/*/access_requests`, () => {
    return HttpResponse.json(fixtures.mockAccessRequestsList);
  }),

  http.post(`${BASE_URL}/projects/*/access_requests`, () => {
    return HttpResponse.json(fixtures.mockAccessRequest, { status: 201 });
  }),

  http.put(`${BASE_URL}/projects/*/access_requests/*/approve`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    const parts = request.url.split('/');
    const userId = parseInt(parts[parts.length - 2], 10); // second-to-last part

    return HttpResponse.json({
      ...fixtures.mockAccessRequest,
      id: userId,
      access_level: body.access_level || 30,
    });
  }),

  http.delete(`${BASE_URL}/projects/*/access_requests/*`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  // Jobs
  http.get(`${BASE_URL}/projects/*/jobs`, ({ request }) => {
    const scope = parseScopeParam(request);

    if (scope.length > 0 && scope.includes('failed')) {
      return HttpResponse.json(fixtures.mockJobsList.filter(j => j.status === 'failed'));
    }
    return HttpResponse.json(fixtures.mockJobsList);
  }),

  http.get(`${BASE_URL}/projects/*/jobs/*`, ({ request }) => {
    const jobId = extractIidFromUrl(request.url);
    if (jobId === null) {
      return HttpResponse.json({ error: 'Invalid job ID' }, { status: 400 });
    }
    if (jobId === 1234) {
      return HttpResponse.json(fixtures.mockJob);
    }
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),

  http.post(`${BASE_URL}/projects/*/jobs/*/play`, ({ request }) => {
    const parts = request.url.split('/');
    const jobId = parseInt(parts[parts.length - 2], 10); // second-to-last part
    return HttpResponse.json({
      ...fixtures.mockJob,
      id: jobId,
      status: 'pending',
    });
  }),

  // Rate limiting simulation
  http.get(`${BASE_URL}/rate-limit-test`, () => {
    return HttpResponse.json(
      { message: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': '60' } }
    );
  }),

  // Merge Request Notes (MUST be before generic merge_requests/* handlers)
  // Why order matters: MSW matches first handler that fits, more specific patterns must come first
  http.get(`${BASE_URL}/projects/*/merge_requests/*/notes`, ({ request }) => {
    // Try multiple parsing strategies for URL-encoded paths
    let mergeRequestIid = extractMrIidFromNotesUrl(request.url);
    if (mergeRequestIid === null) {
      // Try with URL-decoded path
      const decodedUrl = decodeURIComponent(request.url);
      mergeRequestIid = extractMrIidFromNotesUrl(decodedUrl);
    }
    if (mergeRequestIid === null) {
      // Try alternative pattern matching
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

  http.post(`${BASE_URL}/projects/*/merge_requests/*/notes`, async ({ request }) => {
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

  http.put(`${BASE_URL}/projects/*/merge_requests/*/notes/*`, async ({ request }) => {
    // Parse note ID from URL - handle both /notes/1 and /notes/1?params
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

  http.delete(`${BASE_URL}/projects/*/merge_requests/*/notes/*`, ({ request }) => {
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
  http.get(`${BASE_URL}/projects/*/merge_requests`, ({ request, params }) => {
    const { page } = parsePaginationParams(request);

    // Simple pagination
    if (page === 1) {
      return HttpResponse.json(fixtures.mockMergeRequestsList);
    }
    return HttpResponse.json([]);
  }),

  http.get(`${BASE_URL}/projects/*/merge_requests/*`, ({ request }) => {
    const mergeRequestIid = extractIidFromUrl(request.url);
    if (mergeRequestIid === null) {
      return HttpResponse.json({ error: 'Invalid merge request IID' }, { status: 400 });
    }
    if (mergeRequestIid === 1) {
      return HttpResponse.json(fixtures.mockMergeRequest);
    }
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),

  http.post(`${BASE_URL}/projects/*/merge_requests`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;

    if (!body.source_branch || !body.target_branch || !body.title) {
      return HttpResponse.json(
        { error: 'source_branch, target_branch, and title are required' },
        { status: 400 }
      );
    }

    // Return created merge request
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

  http.put(`${BASE_URL}/projects/*/merge_requests/*`, async ({ request }) => {
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

  http.delete(`${BASE_URL}/projects/*/merge_requests/*`, ({ request }) => {
    // Check for forbidden project
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
  http.get(`${BASE_URL}/projects/*/issues`, ({ request }) => {
    const { page } = parsePaginationParams(request);

    // Simple pagination
    if (page === 1) {
      return HttpResponse.json(fixtures.mockIssuesList);
    }
    return HttpResponse.json([]);
  }),

  http.get(`${BASE_URL}/projects/*/issues/*`, ({ request }) => {
    const issueIid = extractIidFromUrl(request.url);
    if (issueIid === null) {
      return HttpResponse.json({ error: 'Invalid issue IID' }, { status: 400 });
    }
    if (issueIid === 1) {
      return HttpResponse.json(fixtures.mockIssue);
    }
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),

  http.post(`${BASE_URL}/projects/*/issues`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;

    // Validate required fields
    if (!body.title) {
      return HttpResponse.json({ error: 'title is required' }, { status: 400 });
    }

    // Return created issue
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

  http.delete(`${BASE_URL}/projects/*/issues/*`, ({ request }) => {
    // Check for forbidden project
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
  http.get(`${BASE_URL}/server-error-test`, () => {
    return HttpResponse.json(
      { message: 'Internal Server Error' },
      { status: 503 }
    );
  }),
];

/**
 * Create and configure mock server
 * 
 * Why setupServer: MSW's node integration for testing environments
 */
export const mockServer = setupServer(...handlers);

/**
 * Helper: start server before tests
 */
export function startMockServer() {
  mockServer.listen({ onUnhandledRequest: 'error' });
}

/**
 * Helper: reset handlers between tests
 * 
 * Why: Prevents test pollution from runtime handler modifications
 */
export function resetMockServer() {
  mockServer.resetHandlers();
}

/**
 * Helper: stop server after tests
 */
export function stopMockServer() {
  mockServer.close();
}

