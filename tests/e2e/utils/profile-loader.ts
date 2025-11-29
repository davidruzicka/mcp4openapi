/**
 * Profile operations loader for E2E test parametrization
 * 
 * Extracts all operations from a profile JSON to generate test cases.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface ToolOperation {
  toolName: string;
  action: string;
  operationId: string;
  requiredParams: Record<string, unknown>;
  description: string;
  isComposite: boolean;
}

interface ProfileTool {
  name: string;
  description?: string;
  composite?: boolean;
  operations?: Record<string, string>;
  steps?: Array<{ call: string; store_as: string }>;
  parameters?: Record<string, {
    required?: boolean;
    required_for?: string[];
    type?: string;
    example?: unknown;
    default?: unknown;
  }>;
}

interface Profile {
  tools: ProfileTool[];
}

/**
 * Generate minimal valid params for an action based on profile parameter definitions
 */
function getRequiredParams(
  tool: ProfileTool,
  action: string
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  
  if (!tool.parameters) {
    return params;
  }

  for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
    const isRequired = paramDef.required === true ||
      (paramDef.required_for && paramDef.required_for.includes(action));
    
    if (isRequired) {
      params[paramName] = getParamValue(paramName, paramDef);
    }
  }

  // Add action if the tool has operations map and action parameter is defined
  // (some tools like list_project_jobs have operations but no action param)
  if (tool.operations && tool.parameters?.action && !params.action) {
    params.action = action;
  }

  return params;
}

/**
 * Get a valid test value for a parameter
 */
function getParamValue(
  paramName: string,
  paramDef: { type?: string; example?: unknown; default?: unknown }
): unknown {
  if (paramDef.example !== undefined) {
    return paramDef.example;
  }
  if (paramDef.default !== undefined) {
    return paramDef.default;
  }
  
  // Specific param name mappings for GitLab mock data
  const knownValues: Record<string, unknown> = {
    project_id: '12345',
    group_id: 'davidruzicka',
    resource_id: 'davidruzicka',
    resource_type: 'project',
    merge_request_iid: 1,
    issue_iid: 1,
    badge_id: 1,
    job_id: 1234,
    note_id: 1,
    user_id: 1,
    branch: 'main',
    ref: 'main',
    title: 'Test title',
    body: 'Test comment body',
    source_branch: 'feature/test',
    target_branch: 'main',
    link_url: 'https://example.com',
    image_url: 'https://shields.io/badge/test-passing-green',
    access_level: 30,
  };

  if (paramName in knownValues) {
    return knownValues[paramName];
  }

  switch (paramDef.type) {
    case 'string':
      return 'test-value';
    case 'integer':
      return 1;
    case 'boolean':
      return false;
    case 'array':
      return [];
    default:
      return 'test-value';
  }
}

/**
 * Load all operations from a profile for test parametrization
 */
export function loadProfileOperations(profilePath: string): ToolOperation[] {
  const absolutePath = resolve(profilePath);
  const content = readFileSync(absolutePath, 'utf-8');
  const profile: Profile = JSON.parse(content);
  
  const operations: ToolOperation[] = [];

  for (const tool of profile.tools) {
    if (tool.composite && tool.steps) {
      // Composite tool - single operation
      operations.push({
        toolName: tool.name,
        action: 'composite',
        operationId: `${tool.name}_composite`,
        requiredParams: getRequiredParams(tool, 'composite'),
        description: tool.description || '',
        isComposite: true,
      });
    } else if (tool.operations) {
      // Standard tool with multiple operations
      for (const [action, operationId] of Object.entries(tool.operations)) {
        operations.push({
          toolName: tool.name,
          action,
          operationId,
          requiredParams: getRequiredParams(tool, action),
          description: tool.description || '',
          isComposite: false,
        });
      }
    }
  }

  return operations;
}

/**
 * Group operations by tool for organized test output
 */
export function groupOperationsByTool(
  operations: ToolOperation[]
): Map<string, ToolOperation[]> {
  const grouped = new Map<string, ToolOperation[]>();
  
  for (const op of operations) {
    const existing = grouped.get(op.toolName) || [];
    existing.push(op);
    grouped.set(op.toolName, existing);
  }
  
  return grouped;
}
