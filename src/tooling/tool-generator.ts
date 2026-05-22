/**
 * MCP tool generator from profile definitions
 * 
 * Why: Translates profile config into MCP SDK tool definitions. Handles both
 * simple (single operation) and composite (multi-step) tools.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ParameterDefinition, ParameterType } from '../types/profile.js';
import type { OpenAPIParser } from '../openapi/openapi-parser.js';
import { ValidationError } from '../core/errors.js';
import { RegexValidator } from '../tool-filter/regex/regex-validator.js';
import type { ValidationResult } from '../tool-filter/types.js';

const DEFAULT_REGEX_MAX_LENGTH = 4096;
const DEFAULT_REGEX_PATTERN_MAX_LENGTH = 1024;

export class ToolGenerator {
  private regexValidator: RegexValidator;
  private regexValidationCache = new Map<string, ValidationResult>();
  private compiledRegexCache = new Map<string, RegExp>();

  constructor(private parser: OpenAPIParser) {
    this.regexValidator = new RegexValidator(DEFAULT_REGEX_PATTERN_MAX_LENGTH);
  }

  /**
   * Generate MCP tool from profile definition
   */
  generateTool(toolDef: ToolDefinition): Tool {
    const inputSchema = this.generateInputSchema(toolDef);

    return {
      name: toolDef.name,
      description: toolDef.description,
      inputSchema,
    };
  }

  /**
   * Generate JSON Schema for tool parameters
   * 
   * Why JSON Schema: MCP SDK expects JSON Schema for parameter validation.
   * LLM uses schema to understand what parameters are needed.
   */
  private generateInputSchema(toolDef: ToolDefinition): Tool['inputSchema'] {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    for (const [name, param] of Object.entries(toolDef.parameters)) {
      properties[name] = this.parameterToJsonSchema(param);

      // Add to required if unconditionally required
      if (param.required) {
        required.push(name);
      }

      // Add conditional requirement hints in description
      if (param.required_for && param.required_for.length > 0) {
        const existing = properties[name].description || '';
        properties[name].description = existing +
          ` Required when action is: ${param.required_for.join(', ')}.`;
      }

      if (param.allowed_for && param.allowed_for.length > 0) {
        const existing = properties[name].description || '';
        properties[name].description = existing +
          ` Allowed only when action is: ${param.allowed_for.join(', ')}.`;
      }

      if (param.forbidden_for && param.forbidden_for.length > 0) {
        const existing = properties[name].description || '';
        properties[name].description = existing +
          ` Not allowed when action is: ${param.forbidden_for.join(', ')}.`;
      }

      if (param.enum_for && Object.keys(param.enum_for).length > 0) {
        const existing = properties[name].description || '';
        const summary = Object.entries(param.enum_for)
          .map(([action, values]) => `${action}=[${values.join(', ')}]`)
          .join('; ');
        properties[name].description = existing +
          ` Allowed values by action: ${summary}.`;
      }
    }

    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    };
  }

  /**
   * Convert parameter definition to JSON Schema
   */
  private parameterToJsonSchema(param: ParameterDefinition): Record<string, unknown> {
    if (Array.isArray(param.type)) {
      const oneOf = param.type.map(type => this.parameterTypeToSchema(type, param));
      return {
        description: param.description,
        oneOf,
      };
    }

    const schema = this.parameterTypeToSchema(param.type, param);
    schema.description = param.description;
    return schema;
  }

  private parameterTypeToSchema(
    type: ParameterType,
    param: ParameterDefinition
  ): Record<string, unknown> {
    const schema: Record<string, unknown> = { type };

    if (param.enum) {
      schema.enum = param.enum;
    }

    if (param.default !== undefined) {
      schema.default = param.default;
    }

    if (type === 'string') {
      if (param.minLength !== undefined) {
        schema.minLength = param.minLength;
      }
      if (param.pattern !== undefined) {
        schema.pattern = param.pattern;
      }
      const maxLength = param.pattern !== undefined
        ? Math.min(param.maxLength ?? DEFAULT_REGEX_MAX_LENGTH, DEFAULT_REGEX_MAX_LENGTH)
        : param.maxLength;
      if (maxLength !== undefined) {
        schema.maxLength = maxLength;
      }
    }

    if (type === 'array' && param.items) {
      schema.items = { type: param.items.type };
    }

    if (type === 'object') {
      // Always include properties for object type (empty {} = free-form object)
      schema.properties = param.properties || {};
    }

    return schema;
  }

  /**
   * Validate tool arguments against parameter definitions
   * 
   * Why manual validation: Checks conditional requirements (required_for)
   * which JSON Schema can't express directly.
   */
  validateArguments(toolDef: ToolDefinition, args: Record<string, unknown>): void {
    const action = args['action'] as string | undefined;

    for (const [name, param] of Object.entries(toolDef.parameters)) {
      const value = args[name];

      // Check unconditional required
      if (param.required && value === undefined) {
        throw new ValidationError(`Missing required parameter: ${name}`);
      }

      // Check conditional required
      if (param.required_for && param.required_for.length > 0) {
        if (action && param.required_for.includes(action) && value === undefined) {
          throw new ValidationError(
            `Parameter '${name}' is required for action '${action}'`
          );
        }
      }

      if (value !== undefined && action && param.allowed_for && param.allowed_for.length > 0 && !param.allowed_for.includes(action)) {
        throw new ValidationError(
          `Parameter '${name}' is not allowed for action '${action}'`
        );
      }

      if (value !== undefined && action && param.forbidden_for && param.forbidden_for.includes(action)) {
        throw new ValidationError(
          `Parameter '${name}' is not allowed for action '${action}'`
        );
      }

      if (value !== undefined && action && param.enum_for && param.enum_for[action]) {
        const actionEnumValues = param.enum_for[action];
        if (!actionEnumValues.includes(String(value))) {
          throw new ValidationError(
            `Invalid value for ${name} when action is '${action}'. Must be one of: ${actionEnumValues.join(', ')}`
          );
        }
      }

      // Validate enum
      if (value !== undefined && param.enum && !param.enum.includes(String(value))) {
        throw new ValidationError(
          `Invalid value for ${name}. Must be one of: ${param.enum.join(', ')}`
        );
      }

      // Validate string constraints
      if (value !== undefined && typeof value === 'string') {
        if (param.minLength !== undefined && value.length < param.minLength) {
          throw new ValidationError(
            `Invalid value for ${name}. Length must be at least ${param.minLength}`
          );
        }
        if (param.maxLength !== undefined && value.length > param.maxLength) {
          throw new ValidationError(
            `Invalid value for ${name}. Length must be at most ${param.maxLength}`
          );
        }

        // Security: Enforce safe max length for regex validation even if maxLength is set higher
        // Why: Prevent ReDoS on large inputs. Even valid regexes can be slow on large inputs.
        if (param.pattern !== undefined && value.length > DEFAULT_REGEX_MAX_LENGTH) {
          throw new ValidationError(
            `Invalid value for ${name}. Value too long for pattern matching (max ${DEFAULT_REGEX_MAX_LENGTH} chars)`
          );
        }

        if (param.pattern !== undefined) {
          // Validate regex pattern for ReDoS vulnerabilities
          let validation = this.regexValidationCache.get(param.pattern);
          if (!validation) {
            validation = this.regexValidator.validate(param.pattern);
            this.regexValidationCache.set(param.pattern, validation);
          }

          if (!validation.valid) {
            throw new ValidationError(
              `Invalid pattern for ${name}. Unsafe regex: ${validation.error}`,
              { paramName: name, pattern: param.pattern, reason: validation.error }
            );
          }

          let regex = this.compiledRegexCache.get(param.pattern);
          if (!regex) {
            try {
              regex = new RegExp(param.pattern);
              this.compiledRegexCache.set(param.pattern, regex);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new ValidationError(
                `Invalid pattern for ${name}.`,
                { paramName: name, pattern: param.pattern, reason }
              );
            }
          }

          if (!regex.test(value)) {
            throw new ValidationError(
              `Invalid value for ${name}. Must match pattern: ${param.pattern}`,
              { paramName: name, pattern: param.pattern }
            );
          }
        }
      }
    }
  }

  /**
   * Get operation definition (string or ProxyDownloadOperation) for action
   * 
   * Why: Tools can have string operationIds OR proxy_download configs.
   * This returns the raw definition before extracting operationId.
   */
  getOperationDefinition(toolDef: ToolDefinition, args: Record<string, unknown>) {
    if (!toolDef.operations) return undefined;

    const action = args['action'] as string | undefined;
    
    if (!action) {
      // If single operation, use it directly
      const operations = Object.values(toolDef.operations);
      return operations.length === 1 ? operations[0] : undefined;
    }

    // For resource_type discrimination (e.g., project vs group)
    const resourceType = args['resource_type'] as string | undefined;
    
    if (resourceType) {
      // Try resource-specific operation first
      const key = `${action}_${resourceType}`;
      if (toolDef.operations[key]) {
        return toolDef.operations[key];
      }
    }

    return toolDef.operations[action];
  }

  /**
   * Map tool action to OpenAPI operation ID
   * 
   * Why: Single tool with 'action' parameter maps to multiple operations.
   * Example: manage_badges + action=create => postApiV4ProjectsIdBadges
   * 
   * Note: Returns undefined for ProxyDownloadOperation (not a direct operationId)
   */
  mapActionToOperation(toolDef: ToolDefinition, args: Record<string, unknown>): string | undefined {
    const op = this.getOperationDefinition(toolDef, args);
    if (typeof op === 'string') {
      return op;
    }

    if (op && typeof op === 'object' && 'operationId' in op && typeof op.operationId === 'string') {
      return op.operationId;
    }

    return undefined;
  }

  /**
   * Check if operation requires multipart/form-data
   *
   * Why: Some operations (file uploads) need FormData instead of JSON body.
   * Detected from OpenAPI requestBody.content['multipart/form-data'] with at least one
   * binary-format field. Many frameworks (e.g., DRF) advertise multipart on all endpoints
   * as an alternative encoding; we only treat it as file upload when a binary field exists.
   */
  isMultipartOperation(operationId: string): boolean {
    const operation = this.parser.getOperation(operationId);
    if (!operation?.requestBody?.content) return false;
    const multipartSchema = operation.requestBody.content['multipart/form-data']?.schema;
    if (!multipartSchema) return false;
    // Only treat as multipart when at least one field has format:'binary' (real file upload)
    const props = multipartSchema.properties;
    if (!props) return false;
    return Object.values(props).some(
      (prop) => (prop as { format?: string }).format === 'binary'
    );
  }

  getMultipartFileFieldName(toolDef: ToolDefinition, action?: string): string {
    if (!action) {
      return 'files[0]';
    }

    const operation = toolDef.operations?.[action];
    if (operation && typeof operation === 'object' && 'file_field_name' in operation) {
      const fileFieldName = operation.file_field_name;
      if (typeof fileFieldName === 'string' && fileFieldName.length > 0) {
        return fileFieldName;
      }
    }

    return 'files[0]';
  }

  /**
   * Build FormData body for file upload
   * 
   * @param args Tool arguments including base64Content or filePath
   * @param fileFieldName Field name in FormData (default: 'files[0]')
   */
  buildFormDataBody(args: Record<string, unknown>, fileFieldName = 'files[0]'): FormData {
    const formData = new FormData();
    
    const base64Content = args['base64Content'] as string | undefined;
    const fileName = (args['fileName'] as string) || 'upload';
    const mimeType = (args['mimeType'] as string) || 'application/octet-stream';
    const reservedKeys = new Set(['action', 'base64Content', 'fileName', 'mimeType']);

    for (const [key, value] of Object.entries(args)) {
      if (reservedKeys.has(key) || value === undefined || value === null) {
        continue;
      }

      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        formData.append(key, String(value));
      }
    }
    
    if (base64Content) {
      // Convert base64 to Blob
      let binaryString: string;
      try {
        binaryString = atob(base64Content);
      } catch {
        throw new ValidationError('Invalid base64 content');
      }
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      formData.append(fileFieldName, blob, fileName);
    }
    
    return formData;
  }
}
