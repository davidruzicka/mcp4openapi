import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { MCPServer } from '../mcp/mcp-server.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { DynamicMockEngine } from './dynamic-mock-server.js';
import { loadTestDefinitionSync, validateTestAgainstProfile } from './test-loader.js';
import { processTemplate } from './template-utils.js';
import { Profile } from '../types/profile.js';
import { ProfileLoader } from '../profile/profile-loader.js';
import { assertRequestMatches, assertRequestsSequence } from './request-assertions.js';

type ToolCallResponse = {
  result?: {
    content?: Array<{ type: string; text?: string }>;
  };
  error?: {
    code?: number | string;
    message?: string;
  };
};

const asToolCallResponse = (value: unknown): ToolCallResponse => value as ToolCallResponse;

function configureProfileEnv(profile: Profile, baseUrl: string): void {
  const authConfigs = profile.interceptors?.auth;
  const authList = Array.isArray(authConfigs) ? authConfigs : authConfigs ? [authConfigs] : [];
  for (const authConfig of authList) {
    if (
      (authConfig.type === 'bearer' || authConfig.type === 'query' || authConfig.type === 'custom-header') &&
      authConfig.value_from_env
    ) {
      process.env[authConfig.value_from_env] = 'test-token';
    }
  }

  const baseUrlEnv = profile.interceptors?.base_url?.value_from_env;
  if (baseUrlEnv) {
    process.env[baseUrlEnv] = baseUrl;
  }
}

function assertErrorExpectation(
  error: unknown,
  processedExpect: { error_code?: string; error_message_regex?: string }
): void {
  expect(error).toBeDefined();
  if (processedExpect.error_code) {
    const errorCode = (error as any)?.code;
    expect(errorCode).toBeDefined();
    expect(String(errorCode)).toBe(processedExpect.error_code);
  }
  if (processedExpect.error_message_regex) {
    expect((error as Error).message).toMatch(new RegExp(processedExpect.error_message_regex));
  }
}

describe('generic profile error expectations', () => {
  it('matches error_code against error.code', () => {
    const error = new Error('Validation failed');
    (error as any).code = 'VALIDATION_ERROR';

    expect(() => assertErrorExpectation(error, { error_code: 'VALIDATION_ERROR' })).not.toThrow();
  });

  it('fails when error_code does not match error.code', () => {
    const error = new Error('Validation failed');
    (error as any).code = 'VALIDATION_ERROR';

    expect(() => assertErrorExpectation(error, { error_code: 'AUTH_ERROR' })).toThrow();
  });
});

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

const profileTestRoots = [
  path.join(process.cwd(), 'profiles'),
  path.join(process.cwd(), 'tests', 'profiles')
];
const testFiles = profileTestRoots.flatMap(findTestFiles);

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
    let profile: Profile;

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

      const profileLoader = new ProfileLoader();
      profile = await profileLoader.load(fullProfilePath);
      validateTestAgainstProfile(testDef, profile);

      parser = new OpenAPIParser();
      await parser.load(fullSpecPath);

      const baseUrl = `https://mock-api-${profileName.replace(/[^a-zA-Z0-9-]/g, '-')}.com`;
      mockEngine = new DynamicMockEngine(parser, baseUrl);
      mockEngine.start();

      process.env.MCP4_API_TOKEN = 'test-token';
      process.env.MCP4_API_BASE_URL = baseUrl;
      configureProfileEnv(profile, baseUrl);

      server = new MCPServer();
      await server.initialize(fullSpecPath, fullProfilePath);
    }, 30000);

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

        // Execute via JSON-RPC tool call to support both Simple and Composite tools
        let result: any;
        let error: any;
        try {
          const response = asToolCallResponse(await server.callToolRpc(scenario.tool, processedArgs, undefined, 1));

          if (response.error) {
            // Convert JSON-RPC error to Error object for easier assertion matching
            error = new Error(response.error.message);
            (error as any).code = response.error.code;
          } else if (response.result) {
            // Parse result from content text
            if (response.result.content && response.result.content.length > 0) {
              result = JSON.parse(response.result.content[0].text as string);
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

          if (processedExpect.result_exact) {
            expect(result).toEqual(processedExpect.result_exact);
          }
        } else {
          assertErrorExpectation(error, processedExpect);
        }

        const capturedRequests = mockEngine.getCapturedRequests();
        if (processedExpect.requests) {
          assertRequestsSequence(capturedRequests, processedExpect.requests, processedExpect.allow_additional_requests);
        } else if (processedExpect.request) {
          assertRequestMatches(capturedRequests, processedExpect.request);
        }
      }, scenario.timeout_ms || 10000);
    });
  });
});
