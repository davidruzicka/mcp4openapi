
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MCPServer } from '../mcp-server.js';
import { ProfileLoader } from '../profile-loader.js';
import path from 'path';

const mockIssue = {
  id: 'ISSUE-123',
  idReadable: 'ISSUE-123',
  summary: 'Test Issue',
  description: 'Test Description',
  resolved: null,
  customFields: [],
  comments: [
    {
      id: 'comment-1',
      text: 'Test Comment',
      author: {
        id: 'user-1',
        login: 'user1'
      },
      created: 1234567890,
      attachments: [
        {
          id: 'att-1',
          name: 'test.txt',
          url: 'http://example.com/test.txt'
        }
      ]
    }
  ],
  attachments: [
    {
      id: 'att-2',
      name: 'issue-att.txt',
      mimeType: 'text/plain',
      size: 100,
      url: 'http://example.com/issue-att.txt'
    }
  ]
};

describe('YouTrack Integration Tests', () => {
  const server = setupServer();
  let mcpServer: MCPServer;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: 'error' });
    
    // Load YouTrack profile
    const profileLoader = new ProfileLoader();
    const profilePath = path.resolve(process.cwd(), 'profiles/youtrack/profile.json');
    const openApiPath = path.resolve(process.cwd(), 'profiles/youtrack/openapi.json');
    
    // Set env vars for base URL and token
    process.env.MCP4_API_BASE_URL = 'http://youtrack.test/api';
    process.env.MCP4_API_TOKEN = 'test-token';
    
    mcpServer = new MCPServer();
    await mcpServer.initialize(openApiPath, profilePath);
  });

  afterAll(() => {
    server.close();
    delete process.env.MCP4_API_BASE_URL;
    delete process.env.MCP4_API_TOKEN;
  });

  afterEach(() => {
    server.resetHandlers();
  });

  it('should request nested fields and return filtered response', async () => {
    let capturedUrl: URL | undefined;

    server.use(
      http.get('*/issues/ISSUE-123', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(mockIssue);
      })
    );

    const toolDef = mcpServer['profile']!.tools.find(t => t.name === 'retrieve_content')!;
    const result = await mcpServer['executeSimpleTool'](toolDef, {
      action: 'get_issue',
      id: 'ISSUE-123'
    });

    // Verify fields param was sent
    expect(capturedUrl).toBeDefined();
    const fieldsParam = capturedUrl?.searchParams.get('fields');
    expect(fieldsParam).toBeDefined();
    
    // Verify fields param contains nested fields
    expect(fieldsParam).toContain('comments(id,text,author(id,login),created,attachments(id,name,url))');
    expect(fieldsParam).toContain('attachments(id,name,mimeType,size,url)');

    // Verify response structure
    const content = result as any;
    
    // Check top level fields
    expect(content).toHaveProperty('id', 'ISSUE-123');
    expect(content).toHaveProperty('summary', 'Test Issue');
    
    // Check nested comments
    expect(content.comments).toHaveLength(1);
    expect(content.comments[0]).toHaveProperty('text', 'Test Comment');
    expect(content.comments[0].author).toEqual({ id: 'user-1', login: 'user1' });
    
    // Check nested attachments in comments
    expect(content.comments[0].attachments).toHaveLength(1);
    expect(content.comments[0].attachments[0]).toEqual({
      id: 'att-1',
      name: 'test.txt',
      url: 'http://example.com/test.txt'
    });

    // Check issue attachments
    expect(content.attachments).toHaveLength(1);
    expect(content.attachments[0]).toEqual({
      id: 'att-2',
      name: 'issue-att.txt',
      mimeType: 'text/plain',
      size: 100,
      url: 'http://example.com/issue-att.txt'
    });
  });

  it('should handle list_issue_comments with nested attachments', async () => {
    let capturedUrl: URL | undefined;

    server.use(
      http.get('*/issues/ISSUE-123/comments', ({ request }) => {
        capturedUrl = new URL(request.url);
        return HttpResponse.json(mockIssue.comments);
      })
    );

    const toolDef = mcpServer['profile']!.tools.find(t => t.name === 'retrieve_content')!;
    const result = await mcpServer['executeSimpleTool'](toolDef, {
      action: 'list_issue_comments',
      id: 'ISSUE-123'
    });

    // Verify fields param
    const fieldsParam = capturedUrl?.searchParams.get('fields');
    expect(fieldsParam).toContain('attachments(id,name,url)');

    // Verify response
    const content = result as any[];
    expect(content).toHaveLength(1);
    expect(content[0].attachments).toHaveLength(1);
    expect(content[0].attachments[0].name).toBe('test.txt');
  });
});
