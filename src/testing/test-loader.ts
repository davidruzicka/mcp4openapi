import fs from 'fs';
import { ProfileTestDefinitionSchema, ProfileTestDefinition } from './test-schema.js';
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

    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      let isRequired = paramDef.required;

      // Check conditional requirements
      if (!isRequired && paramDef.required_for && action) {
        isRequired = paramDef.required_for.includes(action);
      }

      if (isRequired && !(paramName in scenario.arguments)) {
         throw new Error(`Test scenario '${scenario.name}' missing required argument '${paramName}' for tool '${scenario.tool}'`);
      }
    }
  }
}
