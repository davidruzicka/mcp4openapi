/**
 * Integration tests for MCP server with mock GitLab API
 * 
 * Why: Tests complete flow from MCP tool call to API response.
 * Validates parameter mapping, interceptors, error handling.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'path';
import { MCPServer } from '../mcp-server.js';
import { startMockServer, resetMockServer, stopMockServer } from './mock-gitlab-server.js';
import type { Badge, Branch, AccessRequest, Job, MergeRequest, Issue, CompositeResult } from './test-types.js';

describe('Integration Tests', () => {
  let server: MCPServer;

  beforeAll(async () => {
    // Start mock GitLab API server
    startMockServer();

    // Initialize MCP server with test environment
    process.env.MCP4_API_TOKEN = 'test-token';
    process.env.MCP4_API_BASE_URL = 'https://gitlab.com/api/v4';

    server = new MCPServer();
    const specPath = path.join(process.cwd(), 'profiles/gitlab/openapi.yaml');
    const profilePath = path.join(process.cwd(), 'profiles/gitlab/developer-profile.json');
    
    await server.initialize(specPath, profilePath);
  });

  afterEach(() => {
    resetMockServer();
  });

  afterAll(() => {
    stopMockServer();
  });

  describe('manage_project_badges', () => {
    it('should list project badges', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_project_badges')!,
        {
          project_id: 'my-org/my-project',
          action: 'list',
          page: 1,
          per_page: 20,
        }
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      const badges = result as Badge[];
      expect(badges.length).toBeGreaterThan(0);
      expect(badges[0]).toHaveProperty('id');
      expect(badges[0]).toHaveProperty('name');
    });

    it('should get single badge', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_project_badges')!,
        {
          project_id: 'my-org/my-project',
          action: 'get',
          badge_id: 1,
        }
      );

      expect(result).toBeDefined();
      const badge = result as Badge;
      expect(badge.id).toBe(1);
      expect(badge.name).toBe('Coverage');
    });

    it('should create badge', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_project_badges')!,
        {
          project_id: 'my-org/my-project',
          action: 'create',
          link_url: 'https://example.com/new',
          image_url: 'https://shields.io/badge/new-badge-blue',
          name: 'New Badge',
        }
      );

      expect(result).toBeDefined();
      const badge = result as Badge;
      expect(badge.id).toBe(3);
      expect(badge.link_url).toBe('https://example.com/new');
    });

    it('should update badge', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_project_badges')!,
        {
          project_id: 'my-org/my-project',
          action: 'update',
          badge_id: 1,
          name: 'Updated Coverage',
        }
      );

      expect(result).toBeDefined();
      const badge = result as Badge;
      expect(badge.name).toBe('Updated Coverage');
    });

    it('should delete badge', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_project_badges')!,
        {
          project_id: 'my-org/my-project',
          action: 'delete',
          badge_id: 1,
        }
      );

      // 204 No Content returns empty body
      expect(result).toBeDefined();
    });

    it('should return 404 for non-existent badge', async () => {
      await expect(async () => {
        await server['executeSimpleTool'](
          server['profile']!.tools.find(t => t.name === 'manage_project_badges')!,
          {
            project_id: 'my-org/my-project',
            action: 'get',
            badge_id: 999,
          }
        );
      }).rejects.toThrow();
    });
  });

  describe('manage_branches', () => {
    it('should list branches', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_branches')!,
        {
          project_id: 'my-org/my-project',
          action: 'list',
        }
      );

      expect(Array.isArray(result)).toBe(true);
      expect((result as Branch[]).length).toBeGreaterThan(0);
      expect((result as Branch[])[0]).toHaveProperty('name');
    });

    it('should search branches', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_branches')!,
        {
          project_id: 'my-org/my-project',
          action: 'list',
          search: 'feature/',
        }
      );

      expect(Array.isArray(result)).toBe(true);
      const branches = result as Branch[];
      expect(branches.every(b => b.name.includes('feature/'))).toBe(true);
    });

    it('should get single branch', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_branches')!,
        {
          project_id: 'my-org/my-project',
          action: 'get',
          branch: 'main',
        }
      );

      expect((result as Branch).name).toBe('main');
      expect((result as Branch).default).toBe(true);
    });

    it('should create branch', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_branches')!,
        {
          project_id: 'my-org/my-project',
          action: 'create',
          branch: 'feature/test',
          ref: 'main',
        }
      );

      expect((result as Branch).name).toBe('feature/test');
      expect((result as Branch).protected).toBe(false);
    });

    it('should protect branch', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_branches')!,
        {
          project_id: 'my-org/my-project',
          action: 'protect',
          branch: 'main',
        }
      );

      expect((result as Branch).protected).toBe(true);
    });

    it('should not delete default branch', async () => {
      await expect(async () => {
        await server['executeSimpleTool'](
          server['profile']!.tools.find(t => t.name === 'manage_branches')!,
          {
            project_id: 'my-org/my-project',
            action: 'delete',
            branch: 'main',
          }
        );
      }).rejects.toThrow();
    });
  });

  describe('manage_access_requests', () => {
    it('should list project access requests', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_access_requests')!,
        {
          resource_type: 'project',
          resource_id: 'my-org/my-project',
          action: 'list',
        }
      );

      expect(Array.isArray(result)).toBe(true);
      expect((result as Branch[]).length).toBeGreaterThan(0);
    });

    it('should approve access request', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_access_requests')!,
        {
          resource_type: 'project',
          resource_id: 'my-org/my-project',
          action: 'approve',
          user_id: 1,
          access_level: 30,
        }
      );

      expect((result as AccessRequest).access_level).toBe(30);
    });

    it('should handle group access requests', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_access_requests')!,
        {
          resource_type: 'group',
          resource_id: 'my-org',
          action: 'list',
        }
      );

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('list_project_jobs', () => {
    it('should list all jobs', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'list_project_jobs')!,
        {
          project_id: 'my-org/my-project',
        }
      );

      expect(Array.isArray(result)).toBe(true);
      expect((result as Branch[]).length).toBe(2);
    });

    it('should filter jobs by scope', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'list_project_jobs')!,
        {
          project_id: 'my-org/my-project',
          scope: ['failed'],
        }
      );

      expect(Array.isArray(result)).toBe(true);
      const jobs = result as Job[];
      expect(jobs.length).toBe(1);
      expect(jobs[0].status).toBe('failed');
    });
  });

  describe('manage_job', () => {
    it('should get job details', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_job')!,
        {
          project_id: 'my-org/my-project',
          action: 'get',
          job_id: 1234,
        }
      );

      expect((result as Job).id).toBe(1234);
      expect((result as Branch).name).toBe('test:unit');
    });

    it('should play manual job', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_job')!,
        {
          project_id: 'my-org/my-project',
          action: 'play',
          job_id: 1234,
        }
      );

      expect((result as Job).status).toBe('pending');
    });
  });

  describe('manage_merge_requests', () => {
    it('should list merge requests', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'list',
          page: 1,
          per_page: 20,
        }
      );

      expect(result).toBeDefined();
      const mergeRequests = result as MergeRequest[];
      expect(mergeRequests).toHaveLength(2);
      expect(mergeRequests[0].title).toBe('Implement new feature');
      expect(mergeRequests[0].state).toBe('opened');
    });

    it('should get merge request details', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'get',
          merge_request_iid: 1,
        }
      );

      expect(result).toBeDefined();
      const mergeRequest = result as MergeRequest;
      expect(mergeRequest.iid).toBe(1);
      expect(mergeRequest.title).toBe('Implement new feature');
      expect(mergeRequest.source_branch).toBe('feature/new-feature');
      expect(mergeRequest.target_branch).toBe('main');
    });

    it('should create merge request', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'create',
          source_branch: 'feature/test-branch',
          target_branch: 'main',
          title: 'Test merge request creation',
          description: 'This is a test merge request created by integration test.',
        }
      );

      expect(result).toBeDefined();
      const mergeRequest = result as MergeRequest;
      expect(mergeRequest.iid).toBe(3);
      expect(mergeRequest.title).toBe('Test merge request creation');
      expect(mergeRequest.state).toBe('opened');
      expect(mergeRequest.web_url).toBe('https://gitlab.com/my-org/my-project/-/merge_requests/3');
      expect(mergeRequest.created_at).toBeDefined();
    });

    it('should update merge request', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'update',
          merge_request_iid: 1,
          title: 'Updated merge request title',
          description: 'Updated description',
        }
      );

      expect(result).toBeDefined();
      const mergeRequest = result as MergeRequest;
      expect(mergeRequest.iid).toBe(1);
      expect(mergeRequest.title).toBe('Updated merge request title');
      expect(mergeRequest.description).toBe('Updated description');
      expect(mergeRequest.updated_at).toBeDefined();
    });

    it('should delete merge request', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'delete',
          merge_request_iid: 1,
        }
      );

      // 204 No Content returns empty body
      expect(result).toBeDefined();
    });

    it('should list merge request notes', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'list_notes',
          merge_request_iid: 1,
        }
      );

      expect(result).toBeDefined();
      const notes = result as Array<Record<string, unknown>>;
      expect(Array.isArray(notes)).toBe(true);
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0].body).toBeDefined();
      expect(notes[0].author).toBeDefined();
    });

    it('should create merge request note', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'create_note',
          merge_request_iid: 1,
          body: 'This is a test comment',
        }
      );

      expect(result).toBeDefined();
      const note = result as Record<string, unknown>;
      expect(note.id).toBe(3);
      expect(note.body).toBe('This is a test comment');
      expect(note.author).toBeDefined();
      expect(note.created_at).toBeDefined();
    });

    it('should update merge request note', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'update_note',
          merge_request_iid: 1,
          note_id: 1,
          body: 'Updated comment text',
        }
      );

      expect(result).toBeDefined();
      const note = result as Record<string, unknown>;
      expect(note.id).toBe(1);
      expect(note.body).toBe('Updated comment text');
      expect(note.updated_at).toBeDefined();
    });

    it('should delete merge request note', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
        {
          project_id: 'my-org/my-project',
          action: 'delete_note',
          merge_request_iid: 1,
          note_id: 1,
        }
      );

      // 204 No Content returns empty body
      expect(result).toBeDefined();
    });
  });

  describe('get_merge_request_with_details', () => {
    it('should get merge request with notes', async () => {
      const tool = server['profile']!.tools.find(t => t.name === 'get_merge_request_with_details')!;
      expect(tool).toBeDefined();
      expect(tool.composite).toBe(true);

      const result = await server['handleToolCall'](
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_merge_request_with_details',
            arguments: {
              project_id: 'my-org/my-project',
              merge_request_iid: 1,
            },
          },
        },
        'test-session'
      );

      expect(result).toBeDefined();
      const response = result as { result: { content: Array<{ type: string; text: string }> } };
      expect(response.result).toBeDefined();
      expect(response.result.content).toBeDefined();
      expect(response.result.content.length).toBeGreaterThan(0);

      const resultData = JSON.parse(response.result.content[0].text) as CompositeResult;
      expect(resultData.data).toBeDefined();
      expect(resultData.data.merge_request).toBeDefined();
      expect((resultData.data.merge_request as Record<string, unknown>).notes).toBeDefined();
      expect(resultData.completed_steps).toBe(2);
      expect(resultData.total_steps).toBe(2);
      expect(resultData.errors).toBeUndefined();

      const mergeRequest = resultData.data.merge_request as MergeRequest;
      expect(mergeRequest.iid).toBe(1);
      expect(mergeRequest.title).toBeDefined();

      const notes = (resultData.data.merge_request as Record<string, unknown>).notes as Array<Record<string, unknown>>;
      expect(Array.isArray(notes)).toBe(true);
      expect(notes.length).toBeGreaterThan(0);
    });
  });

  describe('manage_issues', () => {
    it('should list issues', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_issues')!,
        {
          project_id: 'my-org/my-project',
          action: 'list',
        }
      );

      expect(result).toBeDefined();
      const issues = result as Issue[];
      expect(Array.isArray(issues)).toBe(true);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].title).toBe('Bug in authentication');
      expect(issues[0].state).toBe('opened');
    });

    it('should get single issue', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_issues')!,
        {
          project_id: 'my-org/my-project',
          action: 'get',
          issue_iid: 1,
        }
      );

      expect(result).toBeDefined();
      const issue = result as Issue;
      expect(issue.iid).toBe(1);
      expect(issue.title).toBe('Bug in authentication');
      expect(issue.state).toBe('opened');
    });

    it('should create issue', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_issues')!,
        {
          project_id: 'my-org/my-project',
          action: 'create',
          title: 'Test issue creation',
          description: 'This is a test issue created by integration test.',
          labels: 'bug,test',
        }
      );

      expect(result).toBeDefined();
      const issue = result as Issue;
      expect(issue.iid).toBe(3);
      expect(issue.title).toBe('Test issue creation');
      expect(issue.state).toBe('opened');
      expect(issue.web_url).toBe('https://gitlab.com/my-org/my-project/-/issues/3');
      expect(issue.created_at).toBeDefined();
    });

    it('should delete issue', async () => {
      const result = await server['executeSimpleTool'](
        server['profile']!.tools.find(t => t.name === 'manage_issues')!,
        {
          project_id: 'my-org/my-project',
          action: 'delete',
          issue_iid: 1,
        }
      );

      // 204 No Content returns empty body
      expect(result).toBeDefined();
    });
  });

  describe('Authorization and Security', () => {
    it('should reject unauthorized issue delete (403)', async () => {
      await expect(
        server['executeSimpleTool'](
          server['profile']!.tools.find(t => t.name === 'manage_issues')!,
          {
            project_id: 'forbidden-project',
            action: 'delete',
            issue_iid: 1,
          }
        )
      ).rejects.toThrow();
    });

    it('should reject unauthorized MR delete (403)', async () => {
      await expect(
        server['executeSimpleTool'](
          server['profile']!.tools.find(t => t.name === 'manage_merge_requests')!,
          {
            project_id: 'forbidden-project',
            action: 'delete',
            merge_request_iid: 1,
          }
        )
      ).rejects.toThrow();
    });

    it('should reject invalid issue IID format', async () => {
      // Mock server will return 400 for invalid IID
      await expect(
        server['executeSimpleTool'](
          server['profile']!.tools.find(t => t.name === 'manage_issues')!,
          {
            project_id: 'my-org/my-project',
            action: 'get',
            issue_iid: -1, // Invalid: negative
          }
        )
      ).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should throw on missing required parameters', async () => {
      const toolGen = server['toolGenerator'];
      const toolDef = server['profile']!.tools.find(t => t.name === 'manage_project_badges')!;

      expect(() => {
        toolGen.validateArguments(toolDef, {
          action: 'list',
          // missing project_id
        });
      }).toThrow(/project_id/);
    });

    it('should throw on missing conditional parameters', async () => {
      const toolGen = server['toolGenerator'];
      const toolDef = server['profile']!.tools.find(t => t.name === 'manage_project_badges')!;

      expect(() => {
        toolGen.validateArguments(toolDef, {
          project_id: '123',
          action: 'create',
          // missing link_url and image_url
        });
      }).toThrow();
    });
  });
});

