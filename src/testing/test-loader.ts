import fs from 'fs';
import { ProfileTestDefinitionSchema, ProfileTestDefinition, CoverageRules } from './test-schema.js';
import { Profile } from '../types/profile.js';

export async function loadTestDefinition(filepath: string): Promise<ProfileTestDefinition> {
  const content = await fs.promises.readFile(filepath, 'utf-8');
  return parseContent(content, filepath);
}

export function loadTestDefinitionSync(filepath: string): ProfileTestDefinition {
  const content = fs.readFileSync(filepath, 'utf-8');
  return parseContent(content, filepath);
}

function parseContent(content: string, filepath: string): ProfileTestDefinition {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse test definition file ${filepath}: ${error}`);
  }

  const result = ProfileTestDefinitionSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`Invalid test definition in ${filepath}: ${result.error.message}`);
  }

  return result.data;
}

export function validateTestAgainstProfile(testDef: ProfileTestDefinition, profile: Profile): void {
  // Check if test definition name matches profile (warning only)
  if (testDef.profile_name && testDef.profile_name !== profile.profile_name) {
    console.warn(`Warning: Test definition profile_name '${testDef.profile_name}' does not match profile name '${profile.profile_name}'`);
  }

  const coveredOperations = new Set<string>();

  for (const scenario of testDef.scenarios) {
    // 1. Check if tool exists
    const tool = profile.tools.find(t => t.name === scenario.tool);
    if (!tool) {
      throw new Error(`Test scenario '${scenario.name}' refers to non-existent tool '${scenario.tool}'`);
    }

    // 2. Simple argument validation (checking if required args are present)
    // This is a basic check. The actual tool execution will do Zod validation.
    // We can iterate over tool.parameters and check 'required' or 'required_for'.
    const action = scenario.arguments['action'];
    const expectSuccess = scenario.expect?.success ?? true;

    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      let isRequired = paramDef.required;

      // Check conditional requirements
      if (!isRequired && paramDef.required_for && action) {
        isRequired = paramDef.required_for.includes(action);
      }

      if (isRequired && !(paramName in scenario.arguments)) {
        if (expectSuccess) {
          throw new Error(`Test scenario '${scenario.name}' missing required argument '${paramName}' for tool '${scenario.tool}'`);
        }
        continue;
      }
    }

    if (tool.operations) {
      const operationKey = resolveOperationKey(tool, scenario.arguments);
      if (operationKey) {
        coveredOperations.add(`${tool.name}.${operationKey}`);
      } else {
        const available = Object.keys(tool.operations);
        throw new Error(
          `Test scenario '${scenario.name}' does not map to a known operation for tool '${scenario.tool}'. ` +
          `Available operations: ${available.join(', ')}`
        );
      }
    }
  }

  enforceCoverage(testDef.coverage, profile, coveredOperations);
}

function resolveOperationKey(tool: Profile['tools'][number], args: Record<string, unknown>): string | undefined {
  if (!tool.operations) return undefined;

  const action = args['action'] as string | undefined;
  const resourceType = args['resource_type'] as string | undefined;
  const operationKeys = Object.keys(tool.operations);

  if (!action) {
    return operationKeys.length === 1 ? operationKeys[0] : undefined;
  }

  if (resourceType) {
    const compositeKey = `${action}_${resourceType}`;
    if (tool.operations[compositeKey]) {
      return compositeKey;
    }
  }

  if (tool.operations[action]) {
    return action;
  }

  return undefined;
}

function enforceCoverage(
  coverage: CoverageRules | undefined,
  profile: Profile,
  coveredOperations: Set<string>
): void {
  if (!coverage?.require_all_actions) {
    return;
  }

  const missing: string[] = [];

  for (const tool of profile.tools) {
    if (!tool.operations) continue;

    for (const action of Object.keys(tool.operations)) {
      const coverageKey = `${tool.name}.${action}`;
      const skipReason = coverage.skip_actions?.[coverageKey] ?? coverage.skip_actions?.[action];
      if (skipReason) {
        continue;
      }

      if (!coveredOperations.has(coverageKey)) {
        missing.push(coverageKey);
      }
    }
  }

  if (missing.length > 0) {
    const skipList = Object.entries(coverage.skip_actions || {}).map(([key, reason]) => `${key} (${reason})`);
    const skipMessage = skipList.length > 0 ? ` Skipped: ${skipList.join(', ')}.` : '';
    throw new Error(`Test coverage incomplete. Missing scenarios for: ${missing.join(', ')}.${skipMessage}`);
  }
}
