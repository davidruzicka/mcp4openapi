#!/usr/bin/env node

/**
 * Profile validation script
 * 
 * Why: Validates profile JSON against schema and checks logical consistency
 * without requiring API access or tokens.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProfileLoader } from '../src/profile/profile-loader.js';
import { OpenAPIParser } from '../src/openapi/openapi-parser.js';
import { ToolGenerator } from '../src/tooling/tool-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: {
    profileName?: string;
    toolCount?: number;
    operations?: number;
    hasInterceptors?: boolean;
  };
}

async function validateProfile(
  profilePath: string,
  specPath?: string
): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
    info: {},
  };

  try {
    // 1. Check if profile file exists
    try {
      await fs.access(profilePath);
    } catch {
      result.valid = false;
      result.errors.push(`Profile file not found: ${profilePath}`);
      return result;
    }

    // 2. Check if it's valid JSON
    let profileContent: string;
    try {
      profileContent = await fs.readFile(profilePath, 'utf-8');
      JSON.parse(profileContent);
    } catch (e) {
      result.valid = false;
      result.errors.push(`Invalid JSON: ${(e as Error).message}`);
      return result;
    }

    // 3. Validate against schema using ProfileLoader
    const loader = new ProfileLoader();
    let profile;
    try {
      profile = await loader.load(profilePath);
      result.info.profileName = profile.profile_name;
      result.info.toolCount = profile.tools.length;
      result.info.hasInterceptors = !!profile.interceptors;
    } catch (e) {
      result.valid = false;
      result.errors.push(`Schema validation failed: ${(e as Error).message}`);
      return result;
    }

    // 4. Check for common issues
    
    // Check for duplicate tool names
    const toolNames = new Set<string>();
    for (const tool of profile.tools) {
      if (toolNames.has(tool.name)) {
        result.valid = false;
        result.errors.push(`Duplicate tool name: ${tool.name}`);
      }
      toolNames.add(tool.name);
    }

    // Check for missing action parameter in non-composite tools
    for (const tool of profile.tools) {
      if (!tool.composite && tool.operations) {
        const actionCount = Object.keys(tool.operations).length;
        if (actionCount > 1 && !tool.parameters.action) {
          result.warnings.push(
            `Tool '${tool.name}' has ${actionCount} operations but no 'action' parameter`
          );
        }
      }
    }

    // Check for metadata_params that don't exist in parameters
    for (const tool of profile.tools) {
      if (tool.metadata_params) {
        for (const metaParam of tool.metadata_params) {
          if (!tool.parameters[metaParam]) {
            result.warnings.push(
              `Tool '${tool.name}': metadata_param '${metaParam}' not found in parameters`
            );
          }
        }
      }
    }

    // Check for required_for references to non-existent actions
    for (const tool of profile.tools) {
      if (!tool.operations) continue;
      
      // Extract valid actions from operation keys
      // Supports patterns: "action", "action_suffix", "prefix_action"
      const validActions = new Set<string>();
      for (const opKey of Object.keys(tool.operations)) {
        validActions.add(opKey); // Add full key (e.g., "list_project")
        
        // Extract parts: "approve_project" → ["approve", "project"]
        const parts = opKey.split('_');
        for (let i = 1; i <= parts.length; i++) {
          // Add combinations: "approve", "approve_project"
          validActions.add(parts.slice(0, i).join('_'));
        }
      }
      
      for (const [paramName, param] of Object.entries(tool.parameters)) {
        if (param.required_for) {
          for (const action of param.required_for) {
            if (!validActions.has(action)) {
              result.warnings.push(
                `Tool '${tool.name}', param '${paramName}': required_for '${action}' not found in operations: ${Object.keys(tool.operations).join(', ')}`
              );
            }
          }
        }
      }
    }

    // 5. If OpenAPI spec provided, validate operations exist
    if (specPath) {
      try {
        await fs.access(specPath);
        
        const parser = new OpenAPIParser();
        await parser.load(specPath);
        
        let operationCount = 0;
        const missingOps: string[] = [];

        for (const tool of profile.tools) {
          if (tool.operations) {
            for (const [action, operationDef] of Object.entries(tool.operations)) {
              operationCount++;
              
              // Handle plain operation IDs, multipart uploads, and proxy download operations
              const operationId = typeof operationDef === 'string'
                ? operationDef
                : 'metadata_endpoint' in operationDef
                  ? operationDef.metadata_endpoint
                  : operationDef.operationId;
              
              try {
                parser.getOperation(operationId);
              } catch {
                missingOps.push(`${tool.name}.${action} → ${operationId}`);
              }
            }
          }
          
          if (tool.steps) {
            for (const step of tool.steps) {
              operationCount++;
              try {
                parser.getOperation(step.call);
              } catch {
                missingOps.push(`${tool.name} step → ${step.call}`);
              }
            }
          }
        }

        result.info.operations = operationCount;

        if (missingOps.length > 0) {
          result.valid = false;
          result.errors.push(
            `Missing operations in OpenAPI spec:\n  - ${missingOps.join('\n  - ')}`
          );
        }
      } catch (e) {
        result.warnings.push(
          `Could not validate against OpenAPI spec: ${(e as Error).message}`
        );
      }
    } else {
      result.warnings.push(
        'OpenAPI spec not provided, skipping operation validation'
      );
    }

    // 6. Validate tool generation (smoke test)
    if (specPath) {
      try {
        const parser = new OpenAPIParser();
        await parser.load(specPath);
        const generator = new ToolGenerator(parser);
        
        for (const toolDef of profile.tools) {
          try {
            generator.generateTool(toolDef);
          } catch (e) {
            result.warnings.push(
              `Tool generation failed for '${toolDef.name}': ${(e as Error).message}`
            );
          }
        }
      } catch {
        // Already handled above
      }
    }

    // 7. Check for best practices
    
    // Warn if too many tools (context pollution)
    if (profile.tools.length > 20) {
      result.warnings.push(
        `Profile has ${profile.tools.length} tools. Consider aggregating related operations to reduce LLM context pollution.`
      );
    }

    // Warn if no interceptors (likely needs auth)
    if (!profile.interceptors || !profile.interceptors.auth) {
      result.warnings.push(
        'No authentication configured. Most APIs require authentication.'
      );
    }

  } catch (e) {
    result.valid = false;
    result.errors.push(`Unexpected error: ${(e as Error).message}`);
  }

  return result;
}

function printResult(result: ValidationResult): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  PROFILE VALIDATION RESULTS');
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // Info
  if (result.info.profileName) {
    console.log(`Profile: ${result.info.profileName}`);
  }
  if (result.info.toolCount !== undefined) {
    console.log(`Tools: ${result.info.toolCount}`);
  }
  if (result.info.operations !== undefined) {
    console.log(`Operations: ${result.info.operations}`);
  }
  if (result.info.hasInterceptors !== undefined) {
    console.log(
      `Interceptors: ${result.info.hasInterceptors ? 'configured' : 'none'}`
    );
  }
  console.log('');

  // Errors
  if (result.errors.length > 0) {
    console.log('❌ ERRORS:');
    for (const error of result.errors) {
      console.log(`  • ${error}`);
    }
    console.log('');
  }

  // Warnings
  if (result.warnings.length > 0) {
    console.log('⚠️  WARNINGS:');
    for (const warning of result.warnings) {
      console.log(`  • ${warning}`);
    }
    console.log('');
  }

  // Status
  if (result.valid && result.errors.length === 0) {
    if (result.warnings.length === 0) {
      console.log('✅ VALID - No issues found');
    } else {
      console.log('✅ VALID - Profile is valid but has warnings');
    }
  } else {
    console.log('❌ INVALID - Profile has errors');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: npm run validate -- <profile.json> [openapi.yaml]

Validates MCP profile configuration without requiring API access.

Arguments:
  <profile.json>    Path to profile file (required)
  [openapi.yaml]    Path to OpenAPI spec (optional, enables operation validation)

Options:
  --help, -h        Show this help message

Examples:
  npm run validate -- profiles/my-api-profile.json
  npm run validate -- profiles/my-api-profile.json openapi.yaml

What is validated:
  ✓ JSON syntax
  ✓ Schema compliance (types, required fields, enums)
  ✓ Logical consistency (required_for references, metadata_params)
  ✓ No duplicate tool names
  ✓ Operations exist in OpenAPI spec (if provided)
  ✓ Tool generation (smoke test)
  ✓ Best practices (tool count, auth configuration)
`);
    process.exit(0);
  }

  const profilePath = path.resolve(process.cwd(), args[0]);
  const specPath = args[1] ? path.resolve(process.cwd(), args[1]) : undefined;

  console.log('Validating profile...');
  console.log(`Profile: ${profilePath}`);
  if (specPath) {
    console.log(`OpenAPI Spec: ${specPath}`);
  }

  const result = await validateProfile(profilePath, specPath);
  printResult(result);

  process.exit(result.valid ? 0 : 1);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
