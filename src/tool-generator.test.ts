/**
 * Tests for tool generator
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ToolGenerator } from './tool-generator.js';
import { OpenAPIParser } from './openapi-parser.js';
import { ProfileLoader } from './profile-loader.js';
import type { Profile } from './types/profile.js';
import path from 'path';

describe('ToolGenerator', () => {
  let generator: ToolGenerator;
  let parser: OpenAPIParser;
  let profile: Profile;

  beforeAll(async () => {
    parser = new OpenAPIParser();
    await parser.load(path.join(process.cwd(), 'profiles/gitlab/openapi.yaml'));
    
    generator = new ToolGenerator(parser);
    
    const loader = new ProfileLoader();
    profile = await loader.load(path.join(process.cwd(), 'profiles/gitlab/developer-profile.json'));
  });

  it('should generate MCP tool from profile definition', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    const tool = generator.generateTool(toolDef!);
    
    expect(tool.name).toBe('manage_project_badges');
    expect(tool.description).toBeDefined();
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toBeDefined();
  });

  it('should generate JSON schema with required fields', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    const tool = generator.generateTool(toolDef!);
    
    expect(tool.inputSchema.required).toContain('project_id');
    expect(tool.inputSchema.required).toContain('action');
  });

  it('should include enum values in schema', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    const tool = generator.generateTool(toolDef!);
    
    const actionProperty = tool.inputSchema.properties?.action as { enum?: string[] };
    expect(actionProperty?.enum).toContain('list');
    expect(actionProperty?.enum).toContain('create');
  });

  it('should validate required parameters', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    expect(() => {
      generator.validateArguments(toolDef!, { action: 'list' });
    }).toThrow(/project_id/);
  });

  it('should validate conditional requirements', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    expect(() => {
      generator.validateArguments(toolDef!, {
        project_id: '123',
        action: 'create'
      });
    }).toThrow(/link_url/);
  });

  it('should map action to operation ID', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    const listOp = generator.mapActionToOperation(toolDef!, {
      action: 'list'
    });
    expect(listOp).toBe('getApiV4ProjectsIdBadges');
    
    const createOp = generator.mapActionToOperation(toolDef!, {
      action: 'create'
    });
    expect(createOp).toBe('postApiV4ProjectsIdBadges');
  });

  it('should handle resource_type discrimination', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_access_requests');
    expect(toolDef).toBeDefined();
    
    const projectOp = generator.mapActionToOperation(toolDef!, {
      action: 'list',
      resource_type: 'project'
    });
    expect(projectOp).toBe('getApiV4ProjectsIdAccessRequests');
    
    const groupOp = generator.mapActionToOperation(toolDef!, {
      action: 'list',
      resource_type: 'group'
    });
    expect(groupOp).toBe('getApiV4GroupsIdAccessRequests');
  });

  it('should reject invalid enum value', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    expect(() => {
      generator.validateArguments(toolDef!, {
        project_id: '123',
        action: 'invalid_action'
      });
    }).toThrow(/Invalid value for action/);
  });
});

