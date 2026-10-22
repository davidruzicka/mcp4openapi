import { describe, it, expect, beforeEach } from 'vitest';
import { MCPServer } from './mcp-server.js';

describe('MCPServer Security', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new (class extends MCPServer {
      constructor() {
        super();
        // Mock the profile for aliases
        (this as any).profile = { parameter_aliases: {} };
      }

      // Expose the private method for testing
      public testResolvePath(template: string, args: Record<string, unknown>) {
        return (this as any).resolvePath(template, args);
      }
    })();
  });

  it('vulnerability: path traversal via parameter injection', () => {
    // This test demonstrates the vulnerability and fix in MCPServer.
    // If the parameter is not encoded properly, ".." segments are injected into the path.
    // NOTE: The fixed behavior is that path contains encoded "%2E%2E"
    // encodeURIComponent('../admin/secrets') => ..%2Fadmin%2Fsecrets (without fix)
    // and with fix it will be %2E%2E%2Fadmin%2Fsecrets

    const maliciousId = '../admin/secrets';

    // Testing the resolvePath directly
    const path = (server as any).testResolvePath('/users/{id}/profile', { id: maliciousId });

    // Vulnerable behavior: path contains raw ".."
    // Fixed behavior: path contains encoded "%2E%2E"
    const expectedFixedPath = '/users/%2E%2E%2Fadmin%2Fsecrets/profile';

    expect(path).toBe(expectedFixedPath);
  });

  it('prevents path traversal with exactly ".." parameter', () => {
    const maliciousId = '..';
    const path = (server as any).testResolvePath('/users/{id}/profile', { id: maliciousId });

    const expectedFixedPath = '/users/%2E%2E/profile';
    expect(path).toBe(expectedFixedPath);
  });

  it('prevents path traversal with exact "." parameter', () => {
    const maliciousId = '.';
    const path = (server as any).testResolvePath('/users/{id}/profile', { id: maliciousId });

    const expectedFixedPath = '/users/%2E/profile';
    expect(path).toBe(expectedFixedPath);
  });
});
