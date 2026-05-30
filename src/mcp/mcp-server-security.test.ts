import { describe, it, expect } from 'vitest';
import { MCPServer } from './mcp-server.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';

describe('MCPServer Security', () => {
  it('vulnerability: path traversal via parameter injection', async () => {
    // We test MCPServer's encodePathSegment method directly since it's private but we can access it via typing override
    const server = new MCPServer(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined
    );

    const encodePathSegment = (server as any).encodePathSegment.bind(server);

    // It should replace dots with %2E to prevent path traversal
    expect(encodePathSegment('..')).toBe('%2E%2E');
    expect(encodePathSegment('.')).toBe('%2E');
    expect(encodePathSegment('../admin')).toBe('%2E%2E%2Fadmin');

    // Regular characters should remain encoded properly
    expect(encodePathSegment('regular/path')).toBe('regular%2Fpath');
    expect(encodePathSegment('hello')).toBe('hello');
  });
});
