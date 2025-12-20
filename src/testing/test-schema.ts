import { z } from 'zod';

export const MockDefinitionSchema = z.object({
  operationId: z.string().describe('The OpenAPI operationId to mock'),
  response: z.object({
    status: z.number().optional().default(200),
    body: z.any().optional(),
    headers: z.record(z.string()).optional(),
    delay: z.number().optional().describe('Response delay in milliseconds')
  }).optional()
});

export const TestExpectationSchema = z.object({
  success: z.boolean().default(true).describe('Whether the tool call should succeed'),
  result: z.any().optional().describe('Expected exact result (partial match)'),
  result_schema: z.any().optional().describe('JSON schema to validate result against'),
  error_code: z.string().optional().describe('Expected error code if success is false'),
  error_message_regex: z.string().optional().describe('Regex to match error message')
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

export const ProfileTestDefinitionSchema = z.object({
  $schema: z.string().optional(),
  profile_name: z.string().optional(),
  variables: z.record(z.any()).optional().describe('Global variables for templating'),
  global_mocks: z.array(MockDefinitionSchema).optional().describe('Default mocks applied to all scenarios'),
  scenarios: z.array(TestScenarioSchema)
});

export type MockDefinition = z.infer<typeof MockDefinitionSchema>;
export type TestExpectation = z.infer<typeof TestExpectationSchema>;
export type TestScenario = z.infer<typeof TestScenarioSchema>;
export type ProfileTestDefinition = z.infer<typeof ProfileTestDefinitionSchema>;
