import fs from 'fs';

const mcpServerTest = 'src/mcp/mcp-server.test.ts';
let mcpServerContent = fs.readFileSync(mcpServerTest, 'utf-8');

mcpServerContent = mcpServerContent.replace(
  /describe\('MCPServer', \(\) => \{/,
  `describe('MCPServer', () => {
  describe('Path traversal protection', () => {
    it('throws ValidationError when path segment is exactly . or ..', () => {
      const server = new (MCPServer as any)({} as any, {} as any, {} as any);
      const encodePathSegment = (server as any).encodePathSegment.bind(server);
      expect(() => encodePathSegment('.')).toThrowError('Path traversal detected for parameter');
      expect(() => encodePathSegment('..')).toThrowError('Path traversal detected for parameter');
      expect(encodePathSegment('valid')).toBe('valid');
      expect(encodePathSegment('some/path')).toBe('some%2Fpath');
    });
  });`
);
fs.writeFileSync(mcpServerTest, mcpServerContent);
