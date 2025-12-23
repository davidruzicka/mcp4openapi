import { z } from 'zod';

const RequestExpectationSchema = z.object({
  method: z.string().optional().describe('Expected HTTP method'),
  path: z.string().optional().describe('Expected request path'),
  origin: z.string().optional().describe('Expected request origin (protocol + host + port)'),
  query: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]))
    .optional()
    .describe('Expected query parameters (strings, numbers, booleans, or arrays)'),
  headers: z.record(z.string()).optional().describe('Expected HTTP headers'),
  headers_absent: z.array(z.string()).optional().describe('Headers that must NOT be present on the request'),
  body: z.any().optional().describe('Expected request body (partial match allowed)')
});

export const MockDefinitionSchema = z.object({
  operationId: z.string().optional().describe('The OpenAPI operationId to mock'),
  path: z.string().optional().describe('Raw URL path pattern (e.g. /api/v4/projects)'),
  method: z.string().optional().describe('HTTP method (GET, POST, etc.)'),
  response: z
    .object({
      status: z.number().optional().default(200),
      body: z.any().optional(),
      headers: z.record(z.string()).optional(),
      delay: z.number().optional().describe('Response delay in milliseconds')
    })
    .optional()
}).refine(data => data.operationId || (data.path && data.method), {
  message: 'Either operationId or (path and method) must be provided'
});

export const TestExpectationSchema = z.object({
  success: z.boolean().default(true).describe('Whether the tool call should succeed'),
  result: z.any().optional().describe('Expected exact result (partial match)'),
  result_exact: z.any().optional().describe('Expected result with deep equality (no extra fields)'),
  result_schema: z.any().optional().describe('JSON schema to validate result against'),
  error_code: z.string().optional().describe('Expected error code if success is false'),
  error_message_regex: z.string().optional().describe('Regex to match error message'),
  request: RequestExpectationSchema.optional().describe('Expected HTTP request details for the scenario'),
  requests: z.array(RequestExpectationSchema).optional().describe('Expected ordered list of HTTP requests'),
  allow_additional_requests: z.boolean().optional().describe('If true, additional captured requests are allowed beyond expectations')
});

export const TestScenarioSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  tool: z.string().describe('Name of the MCP tool to call'),
  arguments: z.record(z.any()).describe('Arguments to pass to the tool'),
  mocks: z.array(MockDefinitionSchema).optional().describe('Scenario-specific mock overrides'),
  expect: TestExpectationSchema,
  timeout_ms: z.number().optional()
});

const CoverageRulesSchema = z
  .object({
    require_all_actions: z.boolean().default(false),
    skip_actions: z.record(z.string().min(1)).default({})
  })
  .default({
    require_all_actions: false,
    skip_actions: {}
  });

export const ProfileTestDefinitionSchema = z.object({
  $schema: z.string().optional(),
  profile_name: z.string().optional(),
  variables: z.record(z.any()).optional().describe('Global variables for templating'),
  global_mocks: z.array(MockDefinitionSchema).optional().describe('Default mocks applied to all scenarios'),
  scenarios: z.array(TestScenarioSchema),
  coverage: CoverageRulesSchema
});

export type RequestExpectation = z.infer<typeof RequestExpectationSchema>;
export type MockDefinition = z.infer<typeof MockDefinitionSchema>;
export type TestExpectation = z.infer<typeof TestExpectationSchema>;
export type TestScenario = z.infer<typeof TestScenarioSchema>;
export type CoverageRules = z.infer<typeof CoverageRulesSchema>;
export type ProfileTestDefinition = z.infer<typeof ProfileTestDefinitionSchema>;
