/**
 * Profile configuration loader and validator
 *
 * Why validation: Profile config comes from user files. Invalid config would
 * cause runtime errors. Validate upfront with clear error messages.
 *
 * ✅ Schemas are now auto-generated from TypeScript types!
 * When adding fields to src/types/profile.ts:
 * 1. Update TypeScript interface (compile-time checking)
 * 2. Run `npm run generate-schemas` (auto-generates JSON + Zod schemas)
 * 3. That's it! No manual sync needed.
 *
 * See IMPLEMENTATION.md for details.
 */

import fs from 'fs/promises';
import type { Profile } from './types/profile.js';
import { ValidationError, ConfigurationError } from './errors.js';
import { ZodError } from 'zod';
import { profileSchema, authInterceptorSchema } from './generated-schemas.js';
import type { OpenAPIParser } from './openapi-parser.js';
import type { OperationInfo, SchemaInfo } from './types/openapi.js';
import { shortenToolName, NamingStrategy, levenshteinDistance, type OperationForNaming, type ShortenResult } from './naming.js';

// Schemas are now auto-generated from TypeScript types!
// See scripts/generate-schemas.js for details.

// Custom validations that can't be auto-generated
const enhancedAuthInterceptorSchema = authInterceptorSchema.refine(
  (data) => {
    if (data.type === 'query' && !data.query_param) {
      return false;
    }
    if (data.type === 'custom-header' && !data.header_name) {
      return false;
    }
    return true;
  },
  {
    message: 'query type requires query_param, custom-header requires header_name',
  }
);

// Override the auth schema in the profile schema tree
// Note: This is a workaround since we can't easily modify the generated schema
const enhancedProfileSchema = profileSchema.superRefine((data, ctx) => {
  const auth = data.interceptors?.auth;
  if (!auth) {
    return;
  }

  const reportIssues = (error: ZodError, basePath: (string | number)[]) => {
    for (const issue of error.issues) {
      const { path, ...rest } = issue;
      ctx.addIssue({
        ...rest,
        path: [...basePath, ...path],
      });
    }
  };

  const validateAuth = (value: unknown, path: (string | number)[]) => {
    const result = enhancedAuthInterceptorSchema.safeParse(value);
    if (!result.success) {
      reportIssues(result.error, path);
    }
  };

  if (Array.isArray(auth)) {
    auth.forEach((entry, index) => {
      validateAuth(entry, ['interceptors', 'auth', index]);
    });
  } else {
    validateAuth(auth, ['interceptors', 'auth']);
  }
});

export class ProfileLoader {
  async load(profilePath: string): Promise<Profile> {
    const content = await fs.readFile(profilePath, 'utf-8');
    const json = JSON.parse(content);
    
    // Validate with Zod - throws detailed error if invalid
    const profile = enhancedProfileSchema.parse(json) as Profile;
    
    this.validateLogic(profile);
    
    return profile;
  }

  /**
   * Validate semantic rules beyond schema
   * 
   * Why separate: Some rules can't be expressed in JSON Schema (e.g.,
   * "if composite=true then steps must exist"). Fail fast with clear messages.
   */
  private validateLogic(profile: Profile): void {
    for (const tool of profile.tools) {
      // Composite tools must have steps
      if (tool.composite && (!tool.steps || tool.steps.length === 0)) {
        throw new ValidationError(
          `Tool '${tool.name}' is marked as composite but has no steps`,
          { toolName: tool.name, composite: tool.composite }
        );
      }

      // Non-composite tools must have operations
      if (!tool.composite && !tool.operations) {
        throw new ValidationError(
          `Tool '${tool.name}' must have either 'operations' or be marked as 'composite' with 'steps'`,
          { toolName: tool.name, composite: tool.composite }
        );
      }

      // Validate required_for references existing enum values
      for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
        if (paramDef.required_for) {
          const actionParam = tool.parameters['action'];
          if (!actionParam?.enum) {
            throw new ValidationError(
              `Parameter '${paramName}' in tool '${tool.name}' has 'required_for' but 'action' parameter has no enum`,
              { toolName: tool.name, paramName, hasActionParam: !!actionParam }
            );
          }

          for (const action of paramDef.required_for) {
            if (!actionParam.enum.includes(action)) {
              throw new ValidationError(
                `Parameter '${paramName}' requires action '${action}' but it's not in action enum: ${actionParam.enum.join(', ')}`,
                { toolName: tool.name, paramName, requiredAction: action, availableActions: actionParam.enum }
              );
            }
          }
        }
      }

      // Validate operation keys match action enum or follow {action}_{resourceType} pattern
      if (tool.operations && tool.parameters['action']?.enum) {
        const actionEnum = tool.parameters['action'].enum;
        const resourceTypeParam = tool.parameters['resource_type'];
        const resourceTypeEnum = resourceTypeParam?.enum;

        for (const operationKey of Object.keys(tool.operations)) {
          // Check if operation key is directly in action enum
          if (actionEnum.includes(operationKey)) {
            continue;
          }

          // Check if operation key follows {action}_{resourceType} pattern
          const parts = operationKey.split('_');
          if (parts.length === 2) {
            const [actionPart, resourceTypePart] = parts;

            // Both parts must be valid
            const actionValid = actionEnum.includes(actionPart);
            const resourceTypeValid = resourceTypeEnum ? resourceTypeEnum.includes(resourceTypePart) : true;

            if (actionValid && resourceTypeValid) {
              continue;
            }
          }

          // Generate helpful error message with suggestions
          const suggestions = this.generateOperationKeySuggestions(operationKey, actionEnum, resourceTypeEnum);
          const suggestionText = suggestions.length > 0
            ? ` Did you mean one of: ${suggestions.join(', ')}?`
            : '';

          throw new ValidationError(
            `Invalid operation key '${operationKey}' in tool '${tool.name}'. ` +
            `Must be an action from enum [${actionEnum.join(', ')}] or follow pattern {action}_{resourceType}.${suggestionText}`,
            {
              toolName: tool.name,
              operationKey,
              availableActions: actionEnum,
              availableResourceTypes: resourceTypeEnum,
              suggestions
            }
          );
        }
      }

      // Validate composite steps DAG (no circular dependencies)
      if (tool.composite && tool.steps) {
        this.validateCompositeStepsDAG(tool.name, tool.steps);
      }
    }
  }

  /**
   * Generate helpful suggestions for invalid operation keys
   */
  private generateOperationKeySuggestions(
    invalidKey: string,
    actionEnum: string[],
    resourceTypeEnum?: string[]
  ): string[] {
    const suggestions: string[] = [];

    // Direct action matches (case-insensitive)
    for (const action of actionEnum) {
      if (action.toLowerCase() === invalidKey.toLowerCase()) {
        suggestions.push(action);
      }
    }

    // Levenshtein distance suggestions for actions
    const maxDistance = Math.min(2, invalidKey.length - 1);
    for (const action of actionEnum) {
      if (levenshteinDistance(invalidKey, action) <= maxDistance) {
        suggestions.push(action);
      }
    }

    // Check for {action}_{resourceType} patterns
    if (resourceTypeEnum) {
      for (const action of actionEnum) {
        for (const resourceType of resourceTypeEnum) {
          const compositeKey = `${action}_${resourceType}`;
          if (levenshteinDistance(invalidKey, compositeKey) <= maxDistance) {
            suggestions.push(compositeKey);
          }
        }
      }
    }

    // Remove duplicates and return unique suggestions
    return [...new Set(suggestions)];
  }

  /**
   * Validate composite steps form a DAG (no circular dependencies)
   *
   * Why: Circular dependencies would cause infinite loops or deadlocks.
   * We use DFS with color-coding to detect cycles.
   */
  private validateCompositeStepsDAG(toolName: string, steps: import('./types/profile.js').CompositeStep[]): void {
    // Build adjacency list: store_as -> list of steps that depend on it
    const graph = new Map<string, string[]>();
    const allStoreAs = new Set<string>();

    // Initialize all nodes
    for (const step of steps) {
      allStoreAs.add(step.store_as);
      if (!graph.has(step.store_as)) {
        graph.set(step.store_as, []);
      }
    }

    // Build dependency edges
    for (const step of steps) {
      if (step.depends_on) {
        for (const dep of step.depends_on) {
          // Validate dependency exists
          if (!allStoreAs.has(dep)) {
            throw new ValidationError(
              `Composite step '${step.store_as}' in tool '${toolName}' depends on '${dep}' but no step produces '${dep}'`,
              { toolName, stepStoreAs: step.store_as, dependency: dep, availableStoreAs: Array.from(allStoreAs) }
            );
          }

          // Add edge: dep -> step.store_as (dep must complete before step)
          if (!graph.has(dep)) {
            graph.set(dep, []);
          }
          graph.get(dep)!.push(step.store_as);
        }
      }
    }

    // DFS cycle detection with color-coding
    const visited = new Set<string>(); // Fully processed nodes
    const visiting = new Set<string>(); // Currently being processed (in recursion stack)

    const dfs = (node: string): void => {
      if (visiting.has(node)) {
        throw new ValidationError(
          `Circular dependency detected in composite steps of tool '${toolName}': ${node} depends on itself`,
          { toolName, circularNode: node, visitingNodes: Array.from(visiting) }
        );
      }

      if (visited.has(node)) {
        return; // Already fully processed
      }

      visiting.add(node);

      // Visit all neighbors
      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        dfs(neighbor);
      }

      visiting.delete(node);
      visited.add(node);
    };

    // Check all nodes for cycles
    for (const node of allStoreAs) {
      if (!visited.has(node)) {
        dfs(node);
      }
    }
  }

  /**
   * Create a default profile with auto-generated tools from OpenAPI spec
   *
   * Why: Allows running server without profile for quick exploration.
   * Generates simple pass-through tools for all operations.
   * 
   * Auth Strategy:
   * 1. Parse security scheme from OpenAPI spec
   * 2. If found, generate auth interceptor
   * 3. Fallback to bearer token from API_TOKEN env var
   */
  static createDefaultProfile(profileName: string, parser: OpenAPIParser): Profile {
    const operations = parser.getAllOperations();
    
    // Get configuration for name shortening
    const maxLength = parseInt(process.env.MCP_TOOLNAME_MAX || '45', 10);
    const strategyStr = (process.env.MCP_TOOLNAME_STRATEGY || 'none').toLowerCase();
    const warnOnly = (process.env.MCP_TOOLNAME_WARN_ONLY || 'true').toLowerCase() === 'true';
    const minParts = parseInt(process.env.MCP_TOOLNAME_MIN_PARTS || '3', 10);
    const minLength = parseInt(process.env.MCP_TOOLNAME_MIN_LENGTH || '20', 10);
    
    const strategy = Object.values(NamingStrategy).includes(strategyStr as NamingStrategy)
      ? (strategyStr as NamingStrategy)
      : NamingStrategy.None;
    
    const shouldShorten = strategy !== NamingStrategy.None && !warnOnly;
    
    // Convert to OperationForNaming for shortening
    const opsForNaming: OperationForNaming[] = operations.map(op => ({
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      tags: op.tags,
    }));

    const tools = operations.map(op => 
      this.generateToolFromOperation(
        op,
        shouldShorten ? strategy : NamingStrategy.None,
        maxLength,
        opsForNaming,
        { minParts, minLength }
      )
    );

    // Generate auth interceptor from OpenAPI security scheme
    const interceptors = this.generateAuthInterceptor(parser);

    return {
      profile_name: profileName,
      description: `Auto-generated default profile with ${tools.length} tools from OpenAPI spec`,
      tools,
      interceptors,
    };
  }

  /**
   * Generate auth interceptor from OpenAPI security scheme
   * 
   * Strategy:
   * 1. Parse security scheme from OpenAPI spec
   * 2. If not found, check for force auth override via env vars
   * 3. Map to profile auth interceptor format
   * 4. Use env var name from AUTH_ENV_VAR or default to API_TOKEN
   * 
   * Returns empty object if no security scheme found (public API) and no force override
   */
  private static generateAuthInterceptor(parser: OpenAPIParser): import('./types/profile.js').InterceptorConfig {
    const securityScheme = parser.getSecurityScheme();
    
    // Check for force auth override (for APIs with incomplete OpenAPI spec)
    const forceAuth = process.env.AUTH_FORCE === 'true';
    
    if (!securityScheme && !forceAuth) {
      return {}; // Public API, no auth required
    }

    // Get env var name from environment or use default
    const envVarName = process.env.AUTH_ENV_VAR || 'API_TOKEN';

    const interceptors: import('./types/profile.js').InterceptorConfig = {};

    // If force auth is enabled, use env config instead of OpenAPI spec
    if (forceAuth && !securityScheme) {
      const authType = (process.env.AUTH_TYPE || 'bearer').toLowerCase();
      
      switch (authType) {
        case 'bearer':
          interceptors.auth = {
            type: 'bearer',
            value_from_env: envVarName,
          };
          break;
        
        case 'query':
          const queryParam = process.env.AUTH_QUERY_PARAM;
          if (!queryParam) {
            throw new ConfigurationError(
              'AUTH_QUERY_PARAM is required when AUTH_TYPE=query',
              { authType }
            );
          }
          interceptors.auth = {
            type: 'query',
            query_param: queryParam,
            value_from_env: envVarName,
          };
          break;
        
        case 'custom-header':
          const headerName = process.env.AUTH_HEADER_NAME;
          if (!headerName) {
            throw new ConfigurationError(
              'AUTH_HEADER_NAME is required when AUTH_TYPE=custom-header',
              { authType }
            );
          }
          interceptors.auth = {
            type: 'custom-header',
            header_name: headerName,
            value_from_env: envVarName,
          };
          break;
        
        default:
          throw new ConfigurationError(
            `Invalid AUTH_TYPE: ${authType}. Must be one of: bearer, query, custom-header`,
            { authType }
          );
      }
      
      return interceptors;
    }

    // Use OpenAPI security scheme
    if (!securityScheme) {
      return {}; // Shouldn't happen, but TypeScript needs this
    }

    switch (securityScheme.type) {
      case 'bearer':
        // Bearer token in Authorization header
        interceptors.auth = {
          type: 'bearer',
          value_from_env: envVarName,
        };
        break;

      case 'apiKey':
        // API key in header or query
        if (securityScheme.in === 'query' && securityScheme.name) {
          interceptors.auth = {
            type: 'query',
            query_param: securityScheme.name,
            value_from_env: envVarName,
          };
        } else if (securityScheme.in === 'header' && securityScheme.name) {
          // Check if it's a standard Authorization header
          if (securityScheme.name.toLowerCase() === 'authorization') {
            interceptors.auth = {
              type: 'bearer',
              value_from_env: envVarName,
            };
          } else {
            interceptors.auth = {
              type: 'custom-header',
              header_name: securityScheme.name,
              value_from_env: envVarName,
            };
          }
        }
        break;

      default:
        // Unknown security type, default to bearer
        interceptors.auth = {
          type: 'bearer',
          value_from_env: envVarName,
        };
    }

    return interceptors;
  }

  /**
   * Generate a simple tool from an OpenAPI operation
   *
   * Creates a tool with parameters based on the operation's path/query/header parameters
   * and request body. Uses operationId as tool name and summary/description for tool description.
   */
  private static generateToolFromOperation(
    operation: OperationInfo,
    strategy: NamingStrategy = NamingStrategy.None,
    maxLength: number = 45,
    allOperations: OperationForNaming[] = [],
    options?: { minParts?: number; minLength?: number }
  ): import('./types/profile.js').ToolDefinition {
    const parameters: Record<string, import('./types/profile.js').ParameterDefinition> = {};

    // Add path parameters
    for (const param of operation.parameters) {
      parameters[param.name] = {
        type: this.mapOpenAPISchemaToParameterType(param.schema),
        description: param.description || `Parameter ${param.name}`,
        required: param.required,
      };
    }

    // Add request body parameters if present
    if (operation.requestBody?.content) {
      // For simplicity, assume JSON content and flatten the schema
      const jsonContent = operation.requestBody.content['application/json'];
      if (jsonContent?.schema) {
        this.flattenSchemaToParameters(jsonContent.schema, parameters, operation.requestBody.required);
      }
    }

    // Warn if parameter inflation exceeds threshold
    const paramCount = Object.keys(parameters).length;
    if (paramCount > 60) {
      // Using console.warn to avoid adding logger dependency here
      console.warn(
        `[ProfileLoader] Generated tool has ${paramCount} parameters (>60). Operation: ${operation.operationId} ${operation.method.toUpperCase()} ${operation.path}`
      );
    }

    // Apply name shortening if strategy is specified
    const opForNaming: OperationForNaming = {
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      tags: operation.tags,
    };
    
    const nameResult = shortenToolName(
      opForNaming,
      strategy,
      maxLength,
      allOperations.length > 0 ? allOperations : [opForNaming],
      options
    );

    return {
      name: nameResult.name,
      description: operation.summary || operation.description || `Execute ${operation.method.toUpperCase()} ${operation.path}`,
      operations: {
        'execute': operation.operationId,
      },
      parameters,
    };
  }

  /**
   * Map OpenAPI schema to parameter type
   */
  private static mapOpenAPISchemaToParameterType(schema: SchemaInfo): 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' {
    switch (schema.type) {
      case 'string':
        return 'string';
      case 'integer':
        return 'integer';
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return 'array';
      case 'object':
        return 'object';
      default:
        return 'string'; // fallback
    }
  }

  /**
   * Recursively flatten schema properties to parameters
   */
  private static flattenSchemaToParameters(
    schema: SchemaInfo,
    parameters: Record<string, import('./types/profile.js').ParameterDefinition>,
    required: boolean = false
  ): void {
    if (schema.type === 'object' && schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const isRequired = schema.required?.includes(propName) || required;
        parameters[propName] = {
          type: this.mapOpenAPISchemaToParameterType(propSchema as SchemaInfo),
          description: `Property ${propName}`,
          required: isRequired,
        };
      }
    }
  }
}

