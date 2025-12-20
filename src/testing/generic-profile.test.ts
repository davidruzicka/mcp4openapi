import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { MCPServer } from '../mcp-server.js';
import { OpenAPIParser } from '../openapi-parser.js';
import { DynamicMockEngine } from './dynamic-mock-server.js';
import { loadTestDefinitionSync } from './test-loader.js';
import { ProfileTestDefinition } from './test-schema.js';
import { processTemplate } from './template-utils.js';

// Helper to find test files
function findTestFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results.push(...findTestFiles(filePath));
    } else {
      if (file.endsWith('.test.json') && !file.endsWith('package.json') && !file.endsWith('tsconfig.json')) {
        results.push(filePath);
      }
    }
  }
  return results;
}

const profilesDir = path.join(process.cwd(), 'profiles');
const testFiles = findTestFiles(profilesDir);

if (testFiles.length === 0) {
  describe('Generic Profile Tests', () => {
    it('should have test files (skipped if none found)', () => {
      // No tests found, strictly passing
    });
  });
}

testFiles.forEach(testFile => {
  const testDef = loadTestDefinitionSync(testFile);
  const testDir = path.dirname(testFile);
  const profileName = testDef.profile_name || path.basename(testDir);

  describe(`Profile Test: ${profileName} (${path.basename(testFile)})`, () => {
    let server: MCPServer;
    let mockEngine: DynamicMockEngine;
    let parser: OpenAPIParser;

    beforeAll(async () => {
      const files = fs.readdirSync(testDir);

      const testFileName = path.basename(testFile);
      let profileJsonName = testFileName.replace('.test.json', '.json');

      if (!files.includes(profileJsonName)) {
        const candidate = files.find(f => f.endsWith('.json') && !f.endsWith('.test.json') && !f.endsWith('schema.json') && !f.endsWith('package.json'));
        if (candidate) {
          profileJsonName = candidate;
        } else {
           throw new Error(`Could not find corresponding profile JSON for ${testFile}`);
        }
      }

      const openApiSpec = files.find(f => f.startsWith('openapi.'));
      if (!openApiSpec) {
        throw new Error(`Could not find openapi.* in ${testDir}`);
      }

      const fullProfilePath = path.join(testDir, profileJsonName);
      const fullSpecPath = path.join(testDir, openApiSpec);

      parser = new OpenAPIParser();
      await parser.load(fullSpecPath);

      const baseUrl = `https://mock-api-${profileName.replace(/[^a-zA-Z0-9-]/g, '-')}.com`;
      mockEngine = new DynamicMockEngine(parser, baseUrl);
      mockEngine.start();

      process.env.MCP4_API_TOKEN = 'test-token';
      process.env.MCP4_API_BASE_URL = baseUrl;

      server = new MCPServer();
      await server.initialize(fullSpecPath, fullProfilePath);
    });

    afterAll(() => {
      mockEngine?.stop();
    });

    beforeEach(() => {
      mockEngine.reset();
      if (testDef.global_mocks) {
        const context = { ...testDef.variables };
        const processedGlobalMocks = processTemplate(testDef.global_mocks, context);
        mockEngine.configureMocks(processedGlobalMocks);
      }
    });

    testDef.scenarios.forEach(scenario => {
      it(scenario.name, async () => {
        // Prepare context
        const context = { ...testDef.variables };

        // Process templates
        const processedMocks = scenario.mocks ? processTemplate(scenario.mocks, context) : undefined;
        const processedArgs = processTemplate(scenario.arguments, context);
        const processedExpect = processTemplate(scenario.expect, context);

        // Configure scenario mocks
        if (processedMocks) {
          mockEngine.configureMocks(processedMocks);
        }

        // Execute via handleToolCall to support both Simple and Composite tools
        let result: any;
        let error: any;
        try {
          // Use 'handleToolCall' (private) via any cast
          const response = await (server as any).handleToolCall({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: scenario.tool,
              arguments: processedArgs
            }
          });

          if (response.error) {
             // Convert JSON-RPC error to Error object for easier assertion matching
             error = new Error(response.error.message);
             (error as any).code = response.error.code;
          } else if (response.result) {
             // Parse result from content text
             if (response.result.content && response.result.content.length > 0) {
                result = JSON.parse(response.result.content[0].text);
             } else {
                result = null; // Empty success
             }
          } else {
             // Unexpected response structure
             error = new Error('Invalid JSON-RPC response');
          }
        } catch (e) {
          error = e;
        }

        // Assertions
        if (processedExpect.success) {
           if (error) {
             console.error(`Scenario '${scenario.name}' failed unexpectedly:`, error);
           }
           expect(error).toBeUndefined();
           expect(result).toBeDefined();

           if (processedExpect.result) {
             expect(result).toMatchObject(processedExpect.result);
           }
        } else {
           expect(error).toBeDefined();
           if (processedExpect.error_code) {
             const msg = (error.message || '').toString();
             expect(msg).toContain(processedExpect.error_code);
           }
           if (processedExpect.error_message_regex) {
             expect(error.message).toMatch(new RegExp(processedExpect.error_message_regex));
           }
        }
      }, scenario.timeout_ms || 10000);
    });
  });
});
