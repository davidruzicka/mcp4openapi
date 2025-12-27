import fs from 'fs';
import { ProfileTestDefinitionSchema, ProfileTestDefinition, CoverageRules, TestScenario } from './test-schema.js';
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
    } else {
      // For composite tools (no operations), use the tool name as the key
      coveredOperations.add(tool.name);
    }
  }

  enforceRequestAssertions(testDef, profile);
  enforceDestructiveActionCoverage(testDef, profile);
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
    if (tool.operations) {
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
    } else {
      // Composite tool coverage check
      const coverageKey = tool.name;
      const skipReason = coverage.skip_actions?.[coverageKey];
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

function enforceRequestAssertions(testDef: ProfileTestDefinition, profile: Profile): void {
  for (const tool of profile.tools) {
    const criticalFeatures = [];

    // Check for parameter aliases (defined in profile, applied to tool if param exists)
    if (profile.parameter_aliases) {
      const toolParamNames = Object.keys(tool.parameters);
      const aliasedParams = Object.keys(profile.parameter_aliases).filter(targetParam =>
        toolParamNames.includes(targetParam)
      );
      if (aliasedParams.length > 0) {
        criticalFeatures.push('parameter_aliases');
      }
    }

    // Check for metadata params (often excluded from body)
    if (tool.metadata_params && tool.metadata_params.length > 0) {
      criticalFeatures.push('metadata_params');
    }

    if (tool.send_response_fields_as_param) {
      criticalFeatures.push('send_response_fields_as_param');
    }

    // Check for proxy operations
    if (tool.operations) {
      const hasProxy = Object.values(tool.operations).some(op =>
        typeof op === 'object' && op.type === 'proxy_download'
      );
      if (hasProxy) {
        criticalFeatures.push('proxy_download');
      }
    }

    if (criticalFeatures.length === 0) continue;

    // Find scenarios for this tool
    const scenarios = testDef.scenarios.filter(s => s.tool === tool.name);

    if (scenarios.length === 0) continue; // Coverage check handles missing scenarios

    // Check if any scenario has request assertions, unless skipped
    // We enforce this per-action (or per-tool if no operations)
    // At least ONE scenario for each action must have assertions.

    if (tool.operations) {
      for (const action of Object.keys(tool.operations)) {
        const coverageKey = `${tool.name}.${action}`;
        const isSkipped = testDef.coverage?.skip_request_assertions?.includes(coverageKey);
        if (isSkipped) continue;

        // Find scenarios for this specific action
        const actionScenarios = scenarios.filter(s => resolveOperationKey(tool, s.arguments) === action);

        if (actionScenarios.length === 0) continue; // Covered by general coverage check

        const hasAssertion = actionScenarios.some(s => s.expect.request || s.expect.requests);
        if (!hasAssertion) {
           throw new Error(
            `No test scenario for action '${coverageKey}' includes request assertions (expect.request or expect.requests), ` +
            `but the tool uses critical features (${criticalFeatures.join(', ')}). ` +
            `Add assertions to at least one scenario for this action.`
          );
        }
      }
    } else {
      // Composite tool (no operations map)
      const coverageKey = tool.name;
      const isSkipped = testDef.coverage?.skip_request_assertions?.includes(coverageKey);
      if (!isSkipped) {
        const hasAssertion = scenarios.some(s => s.expect.request || s.expect.requests);
        if (!hasAssertion) {
           throw new Error(
            `No test scenario for tool '${coverageKey}' includes request assertions (expect.request or expect.requests), ` +
            `but the tool uses critical features (${criticalFeatures.join(', ')}). ` +
            `Add assertions to at least one scenario.`
          );
        }
      }
    }
  }
}

function enforceDestructiveActionCoverage(testDef: ProfileTestDefinition, profile: Profile): void {
  const destructiveRegex = /(delete|remove|revoke|cancel|terminate|reset)/i;
  const missingDestructive: string[] = [];

  for (const tool of profile.tools) {
    if (tool.operations) {
      for (const [action, opDef] of Object.entries(tool.operations)) {
        const opId = typeof opDef === 'string' ? opDef : (opDef as any).operationId; // Type cast as fallback
        const isDestructive = destructiveRegex.test(action) || (opId && destructiveRegex.test(opId));

        if (isDestructive) {
          const coverageKey = `${tool.name}.${action}`;
          const isSkipped = testDef.coverage.skip_actions[coverageKey];
          if (isSkipped) continue;

          // Check if covered
          const covered = testDef.scenarios.some(s => s.tool === tool.name && resolveOperationKey(tool, s.arguments) === action);
          if (!covered) {
            missingDestructive.push(coverageKey);
          }
        }
      }
    } else {
       const isDestructive = destructiveRegex.test(tool.name);
       if (isDestructive) {
         const coverageKey = tool.name;
         const isSkipped = testDef.coverage.skip_actions[coverageKey];
         if (isSkipped) continue;

         const covered = testDef.scenarios.some(s => s.tool === tool.name);
         if (!covered) {
           missingDestructive.push(coverageKey);
         }
       }
    }
  }

  if (missingDestructive.length > 0) {
    throw new Error(
      `Missing test coverage for destructive actions: ${missingDestructive.join(', ')}. ` +
      `Destructive actions must be tested or explicitly skipped in coverage.skip_actions.`
    );
  }
}
