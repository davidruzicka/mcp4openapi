/**
 * Semgrep profile validation tests
 * 
 * Why: Ensures Semgrep profile remains valid against its OpenAPI spec
 * and follows best practices for MCP tool design.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs/promises';
import { ProfileLoader } from '../profile-loader.js';
import { OpenAPIParser } from '../openapi-parser.js';
import { ToolGenerator } from '../tool-generator.js';

const PROFILE_PATH = path.join(process.cwd(), 'profiles/semgrep/profile.json');
const SPEC_PATH = path.join(process.cwd(), 'profiles/semgrep/openapi.yaml');

describe('Semgrep Profile Validation', () => {
  it('should load profile successfully', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    expect(profile.profile_name).toBe('semgrep');
    expect(profile.tools.length).toBeGreaterThan(0);
    expect(profile.interceptors).toBeDefined();
  });

  it('should have correct tool count (10 tools)', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    expect(profile.tools.length).toBe(10);
  });

  it('should have all expected tools', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const expectedTools = [
      'get_deployment',
      'manage_projects',
      'manage_findings',
      'manage_secrets',
      'manage_scans',
      'manage_policies',
      'manage_dependencies',
      'manage_sbom',
      'triage_findings',
      'manage_tickets',
    ];
    
    const toolNames = profile.tools.map(t => t.name);
    for (const expected of expectedTools) {
      expect(toolNames).toContain(expected);
    }
  });

  it('should have no duplicate tool names', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const toolNames = profile.tools.map(t => t.name);
    const uniqueNames = new Set(toolNames);
    expect(uniqueNames.size).toBe(toolNames.length);
  });

  it('should reference valid operations in OpenAPI spec', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const parser = new OpenAPIParser();
    await parser.load(SPEC_PATH);
    
    const missingOps: string[] = [];
    
    for (const tool of profile.tools) {
      if (tool.operations) {
        for (const [action, operationId] of Object.entries(tool.operations)) {
          try {
            parser.getOperation(operationId);
          } catch {
            missingOps.push(`${tool.name}.${action} → ${operationId}`);
          }
        }
      }
    }
    
    expect(missingOps).toEqual([]);
  });

  it('should have properly configured interceptors', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const auth = profile.interceptors?.auth;
    const primaryAuth = Array.isArray(auth) ? auth[0] : auth;
    expect(primaryAuth?.type).toBe('bearer');
    expect(primaryAuth?.value_from_env).toBe('MCP4_API_TOKEN');
    expect(profile.interceptors?.base_url?.default).toBe('https://semgrep.dev');
    expect(profile.interceptors?.rate_limit?.max_requests_per_minute).toBe(600);
    expect(profile.interceptors?.retry?.max_attempts).toBe(3);
  });

  it('should have rate limit overrides for write operations', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const overrides = profile.interceptors?.rate_limit?.overrides;
    expect(overrides).toBeDefined();
    
    // Bulk operations should be rate limited
    expect(overrides?.['TriageService_BulkTriage']?.max_requests_per_minute).toBeLessThan(600);
    expect(overrides?.['TicketingService_CreateTicket']?.max_requests_per_minute).toBeLessThan(600);
    
    // Delete operations should be most restricted
    expect(overrides?.['ProjectsService_DeleteProject']?.max_requests_per_minute).toBeLessThan(10);
  });

  it('should generate valid MCP tools from profile', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const parser = new OpenAPIParser();
    await parser.load(SPEC_PATH);
    
    const generator = new ToolGenerator(parser);
    const generationErrors: string[] = [];
    
    for (const toolDef of profile.tools) {
      try {
        const tool = generator.generateTool(toolDef);
        expect(tool.name).toBe(toolDef.name);
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
      } catch (e) {
        generationErrors.push(`${toolDef.name}: ${(e as Error).message}`);
      }
    }
    
    expect(generationErrors).toEqual([]);
  });

  it('should have composite get_deployment tool', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const deploymentTool = profile.tools.find(t => t.name === 'get_deployment');
    expect(deploymentTool).toBeDefined();
    expect(deploymentTool?.composite).toBe(true);
    expect(deploymentTool?.steps).toBeDefined();
    expect(deploymentTool?.steps?.length).toBeGreaterThan(0);
  });

  it('should have action parameter for multi-operation tools', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const multiOpTools = profile.tools.filter(
      t => t.operations && Object.keys(t.operations).length > 1
    );
    
    for (const tool of multiOpTools) {
      expect(tool.parameters.action).toBeDefined();
      expect(tool.parameters.action?.enum).toBeDefined();
      expect(tool.parameters.action?.enum?.length).toBeGreaterThan(1);
    }
  });

  it('should have parameter_aliases defined', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    expect(profile.parameter_aliases).toBeDefined();
    // Keys must be path parameter names (camelCase from OpenAPI), values are snake_case aliases
    expect(profile.parameter_aliases?.deploymentId).toBeDefined();
    expect(profile.parameter_aliases?.deploymentId).toContain('deployment_id');
    expect(profile.parameter_aliases?.projectName).toBeDefined();
    expect(profile.parameter_aliases?.projectName).toContain('project_name');
  });

  it('should have response_fields for verbosity reduction', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const toolsWithResponseFields = profile.tools.filter(t => t.response_fields);
    expect(toolsWithResponseFields.length).toBeGreaterThan(0);
    
    // Key tools should have response_fields
    const findingsTool = profile.tools.find(t => t.name === 'manage_findings');
    expect(findingsTool?.response_fields).toBeDefined();
    
    const projectsTool = profile.tools.find(t => t.name === 'manage_projects');
    expect(projectsTool?.response_fields).toBeDefined();
  });

  it('should have metadata_params for action routing', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    const toolsWithMetadata = profile.tools.filter(t => t.metadata_params);
    expect(toolsWithMetadata.length).toBeGreaterThan(0);
    
    // Tools with actions should have action in metadata_params
    const projectsTool = profile.tools.find(t => t.name === 'manage_projects');
    expect(projectsTool?.metadata_params).toContain('action');
  });

  it('should exclude MiscService endpoints (Ping, VPC Bootstrap)', async () => {
    const loader = new ProfileLoader();
    const profile = await loader.load(PROFILE_PATH);
    
    // Collect all operation IDs
    const allOperationIds: string[] = [];
    for (const tool of profile.tools) {
      if (tool.operations) {
        allOperationIds.push(...Object.values(tool.operations));
      }
    }
    
    // MiscService operations should not be included
    expect(allOperationIds).not.toContain('MiscService_Ping');
    expect(allOperationIds).not.toContain('MiscService_GetBootstrapSmsVpc');
  });
});
