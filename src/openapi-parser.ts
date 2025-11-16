/**
 * OpenAPI specification parser and indexer
 * 
 * Why indexing: Large OpenAPI specs (GitLab has ~200 operations) need fast lookup.
 * Pre-indexing by operationId and path avoids linear search on every tool call.
 */

import fs from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import type { OpenAPIV3 } from 'openapi-types';
import { ConfigurationError } from './errors.js';
import type { OpenAPIIndex, OperationInfo, ParameterInfo, PathInfo, RequestBodyInfo, SchemaInfo } from './types/openapi.js';

export class OpenAPIParser {
  private spec?: OpenAPIV3.Document;
  private index?: OpenAPIIndex;
  private schemaCache = new Map<string, SchemaInfo>();

  async load(specPath: string): Promise<void> {
    const content = await fs.readFile(specPath, 'utf-8');
    
    // Parse YAML or JSON based on extension
    if (specPath.endsWith('.yaml') || specPath.endsWith('.yml')) {
      this.spec = parseYaml(content) as OpenAPIV3.Document;
    } else {
      this.spec = JSON.parse(content) as OpenAPIV3.Document;
    }

    this.schemaCache.clear();
    this.buildIndex();
  }

  /**
   * Build search index from OpenAPI spec
   * 
   * Why upfront: Trading startup time for runtime performance. Index creation
   * happens once; lookups happen on every tool call.
   */
  private buildIndex(): void {
    if (!this.spec) throw new ConfigurationError('OpenAPI spec not loaded. Call loadSpec() first.');

    this.schemaCache.clear();
    const operations = new Map<string, OperationInfo>();
    const paths = new Map<string, PathInfo>();

    for (const [path, pathItem] of Object.entries(this.spec.paths || {})) {
      if (!pathItem) continue;

      const pathOperations: Record<string, OperationInfo> = {};

      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const) {
        const operation = pathItem[method] as OpenAPIV3.OperationObject | undefined;
        if (!operation) continue;

        const operationInfo = this.extractOperationInfo(path, method, operation);
        
        if (operationInfo.operationId) {
          operations.set(operationInfo.operationId, operationInfo);
        }
        
        pathOperations[method] = operationInfo;
      }

      paths.set(path, { path, operations: pathOperations });
    }

    this.index = {
      spec: this.spec,
      operations,
      paths,
    };
  }

  private extractOperationInfo(
    path: string,
    method: string,
    operation: OpenAPIV3.OperationObject
  ): OperationInfo {
    return {
      operationId: operation.operationId || `${method}_${path}`,
      method: method.toUpperCase(),
      path,
      summary: operation.summary,
      description: operation.description,
      parameters: this.extractParameters(operation),
      requestBody: this.extractRequestBody(operation),
      tags: operation.tags,
    };
  }

  private extractParameters(operation: OpenAPIV3.OperationObject): ParameterInfo[] {
    if (!operation.parameters) return [];

    return operation.parameters
      .map(p => {
        // Resolve $ref to parameter definition
        if ('$ref' in p) {
          return this.resolveParameter(p.$ref);
        }
        return p;
      })
      .filter((p): p is OpenAPIV3.ParameterObject => p !== null)
      .map(param => ({
        name: param.name,
        in: param.in as 'path' | 'query' | 'header' | 'cookie',
        required: param.required ?? false,
        schema: this.extractSchema(param.schema),
        description: param.description,
      }));
  }

  /**
   * Resolve $ref to parameter definition
   * 
   * Why: GitLab spec uses shared parameter definitions (e.g., ProjectIdOrPath).
   * Need to resolve these refs to get actual parameter details.
   */
  private resolveParameter(ref: string): OpenAPIV3.ParameterObject | null {
    if (!this.spec) return null;
    
    // Extract ref path: #/components/parameters/ProjectIdOrPath => ProjectIdOrPath
    const refName = ref.split('/').pop();
    if (!refName) return null;

    const param = this.spec.components?.parameters?.[refName];
    if (!param || '$ref' in param) return null;

    return param as OpenAPIV3.ParameterObject;
  }

  private extractRequestBody(operation: OpenAPIV3.OperationObject): RequestBodyInfo | undefined {
    if (!operation.requestBody || '$ref' in operation.requestBody) return undefined;

    const body = operation.requestBody;
    const content: Record<string, { schema: SchemaInfo }> = {};

    for (const [mediaType, mediaTypeObj] of Object.entries(body.content || {})) {
      if (mediaTypeObj.schema) {
        content[mediaType] = {
          schema: this.extractSchema(mediaTypeObj.schema),
        };
      }
    }

    return {
      required: body.required ?? false,
      content,
    };
  }

  private extractSchema(
    schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
    visited = new Set<string>()
  ): SchemaInfo {
    if (!schema) return {};

    if ('$ref' in schema) {
      const resolved = this.resolveSchema(schema.$ref, visited);
      return resolved ?? { ref: schema.$ref };
    }

    const result: SchemaInfo = {
      type: schema.type as string | undefined,
      format: schema.format,
      enum: schema.enum,
      default: schema.default,
    };

    if (schema.allOf && schema.allOf.length > 0) {
      result.allOf = schema.allOf.map(subSchema => this.extractSchema(subSchema, new Set(visited)));
      for (const sub of result.allOf) {
        this.mergeSchemaInfo(result, sub);
      }
    }

    if (schema.anyOf && schema.anyOf.length > 0) {
      result.anyOf = schema.anyOf.map(subSchema => this.extractSchema(subSchema, new Set(visited)));
      for (const sub of result.anyOf) {
        this.mergeSchemaInfo(result, sub);
      }
    }

    if (schema.oneOf && schema.oneOf.length > 0) {
      result.oneOf = schema.oneOf.map(subSchema => this.extractSchema(subSchema, new Set(visited)));
      for (const sub of result.oneOf) {
        this.mergeSchemaInfo(result, sub);
      }
    }

    if (schema.type === 'array' && schema.items) {
      result.items = this.extractSchema(schema.items, new Set(visited));
    }

    if (schema.type === 'object' && schema.properties) {
      result.properties = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        result.properties[key] = this.extractSchema(propSchema, new Set(visited));
      }
      result.required = schema.required;
    }

    return result;
  }

  private resolveSchema(ref: string, visited = new Set<string>()): SchemaInfo | undefined {
    if (!this.spec) return undefined;

    const refPath = ref.replace(/^#\//, '');
    if (visited.has(refPath)) {
      return { ref, circular: true };
    }

    const cached = this.schemaCache.get(refPath);
    if (cached) {
      return this.cloneSchemaInfo(cached);
    }

    const segments = refPath.split('/');
    let current: unknown = this.spec as unknown;
    for (const segment of segments) {
      if (typeof current !== 'object' || current === null) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[segment];
    }

    if (!current) return undefined;

    visited.add(refPath);
    let resolved: SchemaInfo | undefined;
    if (typeof current === 'object' && current !== null && '$ref' in (current as Record<string, unknown>)) {
      resolved = this.resolveSchema((current as OpenAPIV3.ReferenceObject).$ref, new Set(visited));
    } else {
      resolved = this.extractSchema(current as OpenAPIV3.SchemaObject, new Set(visited));
    }
    visited.delete(refPath);

    if (!resolved) return undefined;

    const canonical = this.cloneSchemaInfo({ ...resolved, ref });
    this.schemaCache.set(refPath, canonical);
    return this.cloneSchemaInfo(canonical);
  }

  private mergeSchemaInfo(target: SchemaInfo, source: SchemaInfo): void {
    if (!target.type && source.type) target.type = source.type;
    if (!target.format && source.format) target.format = source.format;
    if (!target.enum && source.enum) target.enum = source.enum;
    if (target.default === undefined && source.default !== undefined) target.default = source.default;

    if (source.required) {
      target.required = Array.from(new Set([...(target.required ?? []), ...source.required]));
    }

    if (source.properties) {
      target.properties = target.properties ?? {};
      for (const [key, value] of Object.entries(source.properties)) {
        if (target.properties[key]) {
          if (target.properties[key] !== value) {
            this.mergeSchemaInfo(target.properties[key], value);
          }
        } else {
          target.properties[key] = value;
        }
      }
    }

    if (source.items) {
      target.items = target.items ?? source.items;
    }
  }

  private cloneSchemaInfo(schema: SchemaInfo): SchemaInfo {
    const cloned: SchemaInfo = {
      type: schema.type,
      format: schema.format,
      enum: schema.enum ? [...schema.enum] : undefined,
      default: schema.default,
      ref: schema.ref,
      circular: schema.circular,
    };

    if (schema.required) {
      cloned.required = [...schema.required];
    }

    if (schema.items) {
      cloned.items = this.cloneSchemaInfo(schema.items);
    }

    if (schema.properties) {
      cloned.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        cloned.properties[key] = this.cloneSchemaInfo(value);
      }
    }

    if (schema.allOf) {
      cloned.allOf = schema.allOf.map(member => this.cloneSchemaInfo(member));
    }

    if (schema.anyOf) {
      cloned.anyOf = schema.anyOf.map(member => this.cloneSchemaInfo(member));
    }

    if (schema.oneOf) {
      cloned.oneOf = schema.oneOf.map(member => this.cloneSchemaInfo(member));
    }

    return cloned;
  }

  getOperation(operationId: string): OperationInfo | undefined {
    return this.index?.operations.get(operationId);
  }

  getPath(path: string): PathInfo | undefined {
    return this.index?.paths.get(path);
  }

  getBaseUrl(): string {
    const servers = this.spec?.servers;
    return servers?.[0]?.url || '';
  }

  getAllOperations(): OperationInfo[] {
    return Array.from(this.index?.operations.values() || []);
  }

  /**
   * Get first security scheme from OpenAPI spec
   * 
   * Why: When no profile is provided, we need to infer auth configuration from OpenAPI spec.
   * Returns the first security scheme defined in spec.security or components.securitySchemes.
   * 
   * Returns undefined if no security is defined (public API).
   */
  getSecurityScheme(): { type: string; scheme?: string; name?: string; in?: string } | undefined {
    if (!this.spec) return undefined;

    // Check if security is required at spec level
    const globalSecurity = this.spec.security;
    if (!globalSecurity || globalSecurity.length === 0) {
      return undefined; // No security required
    }

    // Get first security requirement
    const firstSecurityReq = globalSecurity[0];
    const securitySchemeName = Object.keys(firstSecurityReq)[0];
    if (!securitySchemeName) return undefined;

    // Resolve security scheme definition
    const securitySchemes = this.spec.components?.securitySchemes;
    if (!securitySchemes) return undefined;

    const scheme = securitySchemes[securitySchemeName];
    if (!scheme || '$ref' in scheme) return undefined;

    // Map OpenAPI security scheme to our auth config format
    const schemeObj = scheme as OpenAPIV3.SecuritySchemeObject;
    
    switch (schemeObj.type) {
      case 'http':
        // http: bearer, basic, etc.
        return {
          type: schemeObj.scheme || 'bearer',
          scheme: schemeObj.scheme,
        };
      
      case 'apiKey':
        // apiKey: in header, query, or cookie
        return {
          type: 'apiKey',
          name: schemeObj.name,
          in: schemeObj.in,
        };
      
      case 'oauth2':
      case 'openIdConnect':
        // OAuth2/OIDC typically use bearer tokens
        return {
          type: 'bearer',
          scheme: 'bearer',
        };
      
      default:
        return undefined;
    }
  }
}

