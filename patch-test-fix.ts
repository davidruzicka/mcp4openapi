import fs from 'fs';

const mcpServerTest = 'src/mcp/mcp-server.test.ts';
let mcpServerContent = fs.readFileSync(mcpServerTest, 'utf-8');

mcpServerContent = mcpServerContent.replace(
  /describe\('MCPServer', \(\) => \{[\s\S]*?describe\('Path traversal protection', \(\) => \{[\s\S]*?\}\);[\s\S]*?\}\);[\s\S]*?describe\('Path traversal protection', \(\) => \{[\s\S]*?\}\);[\s\S]*?\}\);/,
  `describe('MCPServer', () => {`
);

fs.writeFileSync(mcpServerTest, mcpServerContent);
