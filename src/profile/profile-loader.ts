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
import type {
  AuthInterceptor,
  Profile,
  ParameterDefinition,
  ParameterType,
  PromptDefinition,
  SessionCookieConfig,
} from '../types/profile.js';
import { ValidationError, ConfigurationError } from '../core/errors.js';
import { profileSchema, authInterceptorSchema } from '../generated-schemas.js';
import type { OpenAPIParser } from '../openapi/openapi-parser.js';
import { createLoadedProfileAppsModel } from './profile-apps.js';
import type { OperationInfo, SchemaInfo } from '../types/openapi.js';
import { shortenToolName, NamingStrategy, levenshteinDistance, type OperationForNaming } from '../core/naming.js';
import { normalizeToolName } from '../tool-filter/utils.js';
import { isSafePropertyName, isUri } from '../validation/validation-utils.js';

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
    if (data.type === 'session-cookie' && !data.session_cookie_config) {
      return false;
    }
    return true;
  },
  {
    message: 'query type requires query_param, custom-header requires header_name, session-cookie requires session_cookie_config',
  }
);

// Use the basic profile schema - auth validation moved to validateLogic
const enhancedProfileSchema = profileSchema;

export class ProfileLoader {
  async load(profilePath: string, parser?: OpenAPIParser): Promise<Profile> {
    const content = await fs.readFile(profilePath, 'utf-8');
    const json = JSON.parse(content);

    // Validate with Zod - throws detailed error if invalid
    const profile = enhancedProfileSchema.parse(json) as Profile;

    ProfileLoader.normalizeToolNames(profile);
    this.validateLogic(profile);
    this.validateOperations(profile, parser);
    await createLoadedProfileAppsModel(profile, { profilePath, parser });
    
    return profile;
  }

  private validateSessionCookieConfig(
    profile: Profile,
    authEntry: AuthInterceptor & { session_cookie_config: SessionCookieConfig },
    path: string,
  ): void {
    const config = authEntry.session_cookie_config;
    const configPath = `${path}.session_cookie_config`;

    if (!config.login_endpoint.trim()) {
      throw new ValidationError(
        `${configPath}.login_endpoint must not be empty`,
        { path: `${configPath}.login_endpoint` }
      );
    }

    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(config.login_endpoint) && !isUri(config.login_endpoint)) {
      throw new ValidationError(
        `${configPath}.login_endpoint must be a valid absolute URL`,
        { path: `${configPath}.login_endpoint` }
      );
    }

    if (!Array.isArray(config.cookie_names) || config.cookie_names.length === 0) {
      throw new ValidationError(
        `${configPath}.cookie_names must contain at least one cookie name`,
        { path: `${configPath}.cookie_names` }
      );
    }

    for (const cookieName of config.cookie_names) {
      if (!cookieName.trim()) {
        throw new ValidationError(
          `${configPath}.cookie_names must not contain empty values`,
          { path: `${configPath}.cookie_names` }
        );
      }
    }

    if (config.failure_backoff_ms !== undefined && config.failure_backoff_ms <= 0) {
      throw new ValidationError(
        `${configPath}.failure_backoff_ms must be greater than 0`,
        { path: `${configPath}.failure_backoff_ms`, value: config.failure_backoff_ms }
      );
    }

    if (config.expiry_skew_ms !== undefined && config.expiry_skew_ms < 0) {
      throw new ValidationError(
        `${configPath}.expiry_skew_ms must be greater than or equal to 0`,
        { path: `${configPath}.expiry_skew_ms`, value: config.expiry_skew_ms }
      );
    }

    if (config.reauth_on_statuses) {
      if (config.reauth_on_statuses.length === 0) {
        throw new ValidationError(
          `${configPath}.reauth_on_statuses must contain at least one status code`,
          { path: `${configPath}.reauth_on_statuses` }
        );
      }

      for (const statusCode of config.reauth_on_statuses) {
        if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
          throw new ValidationError(
            `${configPath}.reauth_on_statuses must contain integer HTTP error statuses`,
            { path: `${configPath}.reauth_on_statuses`, value: statusCode }
          );
        }
      }
    }

    if (config.login_static_headers) {
      for (const [headerName, headerValue] of Object.entries(config.login_static_headers)) {
        if (!isSafePropertyName(headerName)) {
          throw new ValidationError(
            `${configPath}.login_static_headers contains invalid header name '${headerName}'`,
            { path: `${configPath}.login_static_headers`, headerName }
          );
        }
        if (!headerValue.trim()) {
          throw new ValidationError(
            `${configPath}.login_static_headers must not contain empty header values`,
            { path: `${configPath}.login_static_headers`, headerName }
          );
        }
      }
    }

    if (config.login_allowed_hosts) {
      for (const host of config.login_allowed_hosts) {
        const trimmedHost = host.trim();
        if (!trimmedHost || trimmedHost === '*.' || trimmedHost === '*') {
          throw new ValidationError(
            `${configPath}.login_allowed_hosts contains invalid host pattern '${host}'`,
            { path: `${configPath}.login_allowed_hosts`, host }
          );
        }
      }
    }

    if (!profile.interceptors?.base_url && !isUri(config.login_endpoint)) {
      throw new ValidationError(
        `${configPath}.login_endpoint must be absolute when interceptors.base_url is not configured`,
        { path: `${configPath}.login_endpoint` }
      );
    }
  }

  /**
   * Validate semantic rules beyond schema
   * 
   * Why separate: Some rules can't be expressed in JSON Schema (e.g.,
   * "if composite=true then steps must exist"). Fail fast with clear messages.
   */
  private validateLogic(profile: Profile): void {
    // Validate auth interceptors
    const auth = profile.interceptors?.auth;
    if (auth) {
      const validateAuthEntry = (entry: unknown, index?: number) => {
        const result = enhancedAuthInterceptorSchema.safeParse(entry);
        if (!result.success) {
          const path = index !== undefined ? `interceptors.auth[${index}]` : 'interceptors.auth';
          throw new ValidationError(
            `Invalid auth interceptor at ${path}: ${result.error.issues.map(i => i.message).join(', ')}`,
            { path, issues: result.error.issues }
          );
        }

        // Additional OAuth validation: must have issuer OR both endpoints
        const authEntry = result.data;
        const path = index !== undefined ? `interceptors.auth[${index}]` : 'interceptors.auth';
        if (authEntry.type === 'oauth' && authEntry.oauth_config) {
          const config = authEntry.oauth_config;
          const hasIssuer = !!config.issuer;
          const hasEndpoints = !!config.authorization_endpoint && !!config.token_endpoint;
          
          if (!hasIssuer && !hasEndpoints) {
            const oauthPath = index !== undefined ? `interceptors.auth[${index}].oauth_config` : 'interceptors.auth.oauth_config';
            throw new ValidationError(
              `OAuth config at ${oauthPath} must provide either 'issuer' OR both 'authorization_endpoint' and 'token_endpoint'`,
              { path: oauthPath, hasIssuer, hasEndpoints }
            );
          }
        } else if (authEntry.type === 'session-cookie' && authEntry.session_cookie_config) {
          this.validateSessionCookieConfig(
            profile,
            authEntry as AuthInterceptor & { session_cookie_config: SessionCookieConfig },
            path,
          );
        }
      };

      if (Array.isArray(auth)) {
        auth.forEach((entry, index) => validateAuthEntry(entry, index));
      } else {
        validateAuthEntry(auth);
      }
    }

    const cache = profile.interceptors?.cache;
    if (cache) {
      if (cache.ttl_seconds !== undefined && cache.ttl_seconds <= 0) {
        throw new ValidationError(
          'interceptors.cache.ttl_seconds must be greater than 0',
          { value: cache.ttl_seconds }
        );
      }
      if (cache.max_entries !== undefined && (!Number.isInteger(cache.max_entries) || cache.max_entries <= 0)) {
        throw new ValidationError(
          'interceptors.cache.max_entries must be a positive integer',
          { value: cache.max_entries }
        );
      }
      if (cache.max_memory_bytes !== undefined && (!Number.isInteger(cache.max_memory_bytes) || cache.max_memory_bytes <= 0)) {
        throw new ValidationError(
          'interceptors.cache.max_memory_bytes must be a positive integer',
          { value: cache.max_memory_bytes }
        );
      }
      if (cache.methods && cache.methods.length === 0) {
        throw new ValidationError(
          'interceptors.cache.methods must contain at least one HTTP method',
          { value: cache.methods }
        );
      }
      if (cache.max_memory_bytes_from_env !== undefined && cache.max_memory_bytes_from_env.trim().length === 0) {
        throw new ValidationError(
          'interceptors.cache.max_memory_bytes_from_env must not be empty',
          { value: cache.max_memory_bytes_from_env }
        );
      }
    }

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
        const paramTypes = Array.isArray(paramDef.type) ? paramDef.type : [paramDef.type];
        const hasType = (type: ParameterType) => paramTypes.includes(type);

        // Validate array parameters have items
        if (hasType('array') && !paramDef.items) {
          throw new ValidationError(
            `Parameter '${paramName}' in tool '${tool.name}' is type 'array' but missing required 'items' property`,
            { toolName: tool.name, paramName, paramType: paramDef.type }
          );
        }

        // Validate object parameters have properties
        if (hasType('object') && paramDef.properties === undefined) {
          throw new ValidationError(
            `Parameter '${paramName}' in tool '${tool.name}' is type 'object' but missing 'properties'. Use empty object {} for free-form objects.`,
            { toolName: tool.name, paramName, paramType: paramDef.type }
          );
        }

        const actionEnum = tool.parameters['action']?.enum;
        this.validateConditionalActionRules(tool.name, paramName, paramDef, actionEnum);
        this.validateActionScopedEnumRules(tool.name, paramName, paramDef, actionEnum);
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

    if (profile.prompts) {
      this.validatePrompts(profile.prompts, profile.tools);
    }
  }

  private validateOperations(profile: Profile, parser?: OpenAPIParser): void {
    if (!parser) {
      return;
    }

    for (const tool of profile.tools) {
      if (tool.operations) {
        for (const operationDefinition of Object.values(tool.operations)) {
          if (typeof operationDefinition === 'string') {
            if (!parser.getOperation(operationDefinition)) {
              throw new ValidationError(
                `Operation '${operationDefinition}' in tool '${tool.name}' not found in OpenAPI spec`,
                { path: `tools.${tool.name}.operations`, operationId: operationDefinition, toolName: tool.name },
              );
            }
            continue;
          }

          if (!parser.getOperation(operationDefinition.metadata_endpoint)) {
            throw new ValidationError(
              `Operation '${operationDefinition.metadata_endpoint}' in tool '${tool.name}' not found in OpenAPI spec`,
              { path: `tools.${tool.name}.operations`, operationId: operationDefinition.metadata_endpoint, toolName: tool.name },
            );
          }

          if (operationDefinition.download_endpoint && !parser.getOperation(operationDefinition.download_endpoint)) {
            throw new ValidationError(
              `Operation '${operationDefinition.download_endpoint}' in tool '${tool.name}' not found in OpenAPI spec`,
              { path: `tools.${tool.name}.operations`, operationId: operationDefinition.download_endpoint, toolName: tool.name },
            );
          }
        }
      }

      if (tool.composite && tool.steps) {
        for (const step of tool.steps) {
          const [method, stepPath] = step.call.split(' ');
          const operation = parser.getPath(stepPath)?.operations[method.toLowerCase()];
          if (!operation) {
            throw new ValidationError(
              `Composite step '${step.call}' in tool '${tool.name}' not found in OpenAPI spec`,
              { path: `tools.${tool.name}.steps`, step: step.call, toolName: tool.name },
            );
          }
        }
      }
    }
  }

  private validateConditionalActionRules(
    toolName: string,
    paramName: string,
    paramDef: ParameterDefinition,
    actionEnum: string[] | undefined,
  ): void {
    const rules = [
      { key: 'required_for', values: paramDef.required_for },
      { key: 'allowed_for', values: paramDef.allowed_for },
      { key: 'forbidden_for', values: paramDef.forbidden_for },
    ] as const;
    const activeRules = rules.reduce<Array<{ key: 'required_for' | 'allowed_for' | 'forbidden_for'; values: string[] }>>(
      (result, rule) => {
        if (Array.isArray(rule.values) && rule.values.length > 0) {
          result.push({ key: rule.key, values: rule.values });
        }
        return result;
      },
      [],
    );

    if (activeRules.length === 0) {
      return;
    }

    if (!actionEnum || actionEnum.length === 0) {
      const ruleNames = activeRules.map((rule) => `'${rule.key}'`).join(', ');
      throw new ValidationError(
        `Parameter '${paramName}' in tool '${toolName}' has ${ruleNames} but 'action' parameter has no enum`,
        { toolName, paramName, hasActionEnum: false, rules: activeRules.map((rule) => rule.key) },
      );
    }

    for (const rule of activeRules) {
      for (const action of rule.values) {
        if (!actionEnum.includes(action)) {
          throw new ValidationError(
            `Parameter '${paramName}' has '${rule.key}' action '${action}' but it's not in action enum: ${actionEnum.join(', ')}`,
            { toolName, paramName, rule: rule.key, action, availableActions: actionEnum },
          );
        }
      }
    }

    const allowedFor = paramDef.allowed_for ?? [];
    const forbiddenFor = paramDef.forbidden_for ?? [];
    const requiredFor = paramDef.required_for ?? [];

    const allowedForbiddenOverlap = allowedFor.filter((action) => forbiddenFor.includes(action));
    if (allowedForbiddenOverlap.length > 0) {
      throw new ValidationError(
        `Parameter '${paramName}' in tool '${toolName}' has overlapping 'allowed_for' and 'forbidden_for' actions: ${allowedForbiddenOverlap.join(', ')}`,
        { toolName, paramName, overlap: allowedForbiddenOverlap },
      );
    }

    const requiredForbiddenOverlap = requiredFor.filter((action) => forbiddenFor.includes(action));
    if (requiredForbiddenOverlap.length > 0) {
      throw new ValidationError(
        `Parameter '${paramName}' in tool '${toolName}' has actions required and forbidden at the same time: ${requiredForbiddenOverlap.join(', ')}`,
        { toolName, paramName, overlap: requiredForbiddenOverlap },
      );
    }

    if (allowedFor.length > 0) {
      const missingRequired = requiredFor.filter((action) => !allowedFor.includes(action));
      if (missingRequired.length > 0) {
        throw new ValidationError(
          `Parameter '${paramName}' in tool '${toolName}' has required actions missing from 'allowed_for': ${missingRequired.join(', ')}`,
          { toolName, paramName, missingRequired, allowedFor },
        );
      }
    }
  }

  private validateActionScopedEnumRules(
    toolName: string,
    paramName: string,
    paramDef: ParameterDefinition,
    actionEnum: string[] | undefined,
  ): void {
    if (!paramDef.enum_for) {
      return;
    }

    if (!actionEnum || actionEnum.length === 0) {
      throw new ValidationError(
        `Parameter '${paramName}' in tool '${toolName}' has 'enum_for' but 'action' parameter has no enum`,
        { toolName, paramName, hasActionEnum: false },
      );
    }

    for (const [action, values] of Object.entries(paramDef.enum_for)) {
      if (!actionEnum.includes(action)) {
        throw new ValidationError(
          `Parameter '${paramName}' has 'enum_for' action '${action}' but it's not in action enum: ${actionEnum.join(', ')}`,
          { toolName, paramName, action, availableActions: actionEnum },
        );
      }

      if (!Array.isArray(values) || values.length === 0) {
        throw new ValidationError(
          `Parameter '${paramName}' in tool '${toolName}' has empty 'enum_for' values for action '${action}'`,
          { toolName, paramName, action },
        );
      }

      if (paramDef.enum) {
        const invalidValues = values.filter((value) => !paramDef.enum?.includes(value));
        if (invalidValues.length > 0) {
          throw new ValidationError(
            `Parameter '${paramName}' in tool '${toolName}' has 'enum_for' values not present in base enum for action '${action}': ${invalidValues.join(', ')}`,
            { toolName, paramName, action, invalidValues, enum: paramDef.enum },
          );
        }
      }
    }
  }

  private validatePrompts(
    prompts: PromptDefinition[],
    tools: import('../types/profile.js').ToolDefinition[]
  ): void {
    const promptNames = new Set<string>();
    const toolNames = new Set(tools.map(tool => tool.name));

    for (const prompt of prompts) {
      if (promptNames.has(prompt.name)) {
        throw new ValidationError(
          `Duplicate prompt name '${prompt.name}'`,
          { promptName: prompt.name }
        );
      }
      promptNames.add(prompt.name);

      if (toolNames.has(prompt.name)) {
        throw new ValidationError(
          `Prompt '${prompt.name}' conflicts with existing tool name`,
          { promptName: prompt.name }
        );
      }

      if (prompt.messages.length === 0) {
        throw new ValidationError(
          `Prompt '${prompt.name}' must have at least one message`,
          { promptName: prompt.name }
        );
      }

      if (!prompt.arguments || prompt.arguments.length === 0) {
        continue;
      }

      const argumentNames = new Set<string>();
      const requiredArguments = new Set<string>();

      for (const argument of prompt.arguments) {
        if (argumentNames.has(argument.name)) {
          throw new ValidationError(
            `Prompt '${prompt.name}' has duplicate argument '${argument.name}'`,
            { promptName: prompt.name, argumentName: argument.name }
          );
        }
        argumentNames.add(argument.name);

        if (argument.required) {
          requiredArguments.add(argument.name);
        }
      }

      if (requiredArguments.size === 0) {
        continue;
      }

      const templateVariables = new Set<string>();
      for (const message of prompt.messages) {
        if (message.content.type !== 'text') {
          continue;
        }

        for (const variableName of this.extractPromptTemplateVariables(message.content.text)) {
          templateVariables.add(variableName);
        }
      }

      for (const argumentName of requiredArguments) {
        if (!templateVariables.has(argumentName)) {
          throw new ValidationError(
            `Prompt '${prompt.name}' defines required argument '${argumentName}' but no message references it as '{{${argumentName}}}'`,
            { promptName: prompt.name, argumentName, templateVariables: Array.from(templateVariables) }
          );
        }
      }
    }
  }

  private extractPromptTemplateVariables(template: string): string[] {
    const variableNames: string[] = [];
    const tokenPattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

    for (const match of template.matchAll(tokenPattern)) {
      variableNames.push(match[1]);
    }

    return variableNames;
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
  private validateCompositeStepsDAG(toolName: string, steps: import('../types/profile.js').CompositeStep[]): void {
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
   * 3. Fallback to bearer token from MCP4_API_TOKEN env var
   */
  static createDefaultProfile(profileName: string, parser: OpenAPIParser): Profile {
    const operations = parser.getAllOperations();
    
    // Get configuration for name shortening
    const maxLength = parseInt(process.env.MCP4_TOOLNAME_MAX || '45', 10);
    const strategyStr = (process.env.MCP4_TOOLNAME_STRATEGY || 'none').toLowerCase();
    const warnOnly = (process.env.MCP4_TOOLNAME_WARN_ONLY || 'true').toLowerCase() === 'true';
    const minParts = parseInt(process.env.MCP4_TOOLNAME_MIN_PARTS || '3', 10);
    const minLength = parseInt(process.env.MCP4_TOOLNAME_MIN_LENGTH || '20', 10);
    
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

    const profile = {
      profile_name: profileName,
      description: `Auto-generated default profile with ${tools.length} tools from OpenAPI spec`,
      tools,
      interceptors,
    };

    this.normalizeToolNames(profile);

    return profile;
  }

  /**
   * Generate auth interceptor from OpenAPI security scheme
   * 
   * Strategy:
   * 1. Parse security scheme from OpenAPI spec
   * 2. If not found, check for force auth override via env vars
   * 3. Map to profile auth interceptor format
   * 4. Use env var name from AUTH_ENV_VAR or default to MCP4_API_TOKEN
   * 
   * Returns empty object if no security scheme found (public API) and no force override
   */
  private static generateAuthInterceptor(parser: OpenAPIParser): import('../types/profile.js').InterceptorConfig {
    const securityScheme = parser.getSecurityScheme();
    
    // Check for force auth override (for APIs with incomplete OpenAPI spec)
    const forceAuth = process.env.MCP4_AUTH_FORCE === 'true';

    if (!securityScheme && !forceAuth) {
      return {}; // Public API, no auth required
    }

    // Get env var name from environment or use default
    const envVarName = process.env.MCP4_AUTH_ENV_VAR || 'MCP4_API_TOKEN';

    const interceptors: import('../types/profile.js').InterceptorConfig = {};

    // If force auth is enabled, use env config instead of OpenAPI spec
    if (forceAuth && !securityScheme) {
      const authType = (process.env.MCP4_AUTH_TYPE || 'bearer').toLowerCase();

      switch (authType) {
        case 'bearer':
          interceptors.auth = {
            type: 'bearer',
            value_from_env: envVarName,
          };
          break;

        case 'query':
          const queryParam = process.env.MCP4_AUTH_QUERY_PARAM;
          if (!queryParam) {
            throw new ConfigurationError(
              'MCP4_AUTH_QUERY_PARAM is required when MCP4_AUTH_TYPE=query',
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
          const headerName = process.env.MCP4_AUTH_HEADER_NAME;
          if (!headerName) {
            throw new ConfigurationError(
              'MCP4_AUTH_HEADER_NAME is required when MCP4_AUTH_TYPE=custom-header',
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
            `Invalid MCP4_AUTH_TYPE: ${authType}. Must be one of: bearer, query, custom-header`,
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
  ): import('../types/profile.js').ToolDefinition {
    const parameters: Record<string, import('../types/profile.js').ParameterDefinition> = {};

    // Add path parameters
    for (const param of operation.parameters) {
      parameters[param.name] = {
        type: this.mapOpenAPISchemaToParameterType(param.schema),
        description: param.description || `Parameter ${param.name}`,
        required: param.required,
        minLength: param.schema.minLength,
        maxLength: param.schema.maxLength,
        pattern: param.schema.pattern,
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
    parameters: Record<string, import('../types/profile.js').ParameterDefinition>,
    required: boolean = false
  ): void {
    if (schema.type === 'object' && schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const isRequired = schema.required?.includes(propName) || required;
        const info = propSchema as SchemaInfo;
        parameters[propName] = {
          type: this.mapOpenAPISchemaToParameterType(info),
          description: `Property ${propName}`,
          required: isRequired,
          minLength: info.minLength,
          maxLength: info.maxLength,
          pattern: info.pattern,
        };
      }
    }
  }

  private static normalizeToolNames(profile: Profile): void {
    for (const tool of profile.tools) {
      tool.name = normalizeToolName(tool.name);
    }
  }
}
