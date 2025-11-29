/**
 * Response schema validator for E2E tests
 * 
 * Validates API responses against OpenAPI schema definitions.
 */

import Ajv, { ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as yamlParse } from 'yaml';

interface OpenApiSpec {
  components?: {
    schemas?: Record<string, object>;
  };
  paths?: Record<string, Record<string, {
    responses?: Record<string, {
      content?: Record<string, {
        schema?: object;
      }>;
    }>;
  }>>;
}

/**
 * Schema validator for OpenAPI responses
 */
export class ResponseSchemaValidator {
  private ajv: Ajv;
  private spec: OpenApiSpec;
  private validators: Map<string, ValidateFunction> = new Map();

  constructor(openapiPath: string) {
    this.ajv = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: true,
    });
    addFormats(this.ajv);
    
    const absolutePath = resolve(openapiPath);
    const content = readFileSync(absolutePath, 'utf-8');
    this.spec = yamlParse(content) as OpenApiSpec;
    
    this.registerSchemas();
  }

  private registerSchemas(): void {
    if (!this.spec.components?.schemas) {
      return;
    }

    for (const [name, schema] of Object.entries(this.spec.components.schemas)) {
      const resolved = this.resolveRefs(schema);
      if (typeof resolved !== 'object' || resolved === null) {
        continue;
      }
      const schemaWithId = {
        $id: `#/components/schemas/${name}`,
        ...resolved as Record<string, unknown>,
      };
      
      try {
        this.ajv.addSchema(schemaWithId);
      } catch {
        // Schema may already be added or have issues, skip
      }
    }
  }

  /**
   * Resolve $ref references in schema
   */
  private resolveRefs(schema: unknown): unknown {
    if (schema === null || typeof schema !== 'object') {
      return schema;
    }

    if (Array.isArray(schema)) {
      return schema.map((item) => this.resolveRefs(item));
    }

    const obj = schema as Record<string, unknown>;
    
    if ('$ref' in obj && typeof obj.$ref === 'string') {
      // Keep $ref as-is, Ajv will resolve it
      return obj;
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = this.resolveRefs(value);
    }
    return resolved;
  }

  /**
   * Get validator for a specific schema
   */
  getValidator(schemaName: string): ValidateFunction | undefined {
    if (this.validators.has(schemaName)) {
      return this.validators.get(schemaName);
    }

    const schema = this.spec.components?.schemas?.[schemaName];
    if (!schema) {
      return undefined;
    }

    try {
      const validator = this.ajv.compile({
        ...this.resolveRefs(schema) as object,
      });
      this.validators.set(schemaName, validator);
      return validator;
    } catch {
      return undefined;
    }
  }

  /**
   * Validate data against a named schema
   */
  validate(schemaName: string, data: unknown): { valid: boolean; errors?: string[] } {
    const validator = this.getValidator(schemaName);
    
    if (!validator) {
      return { valid: false, errors: [`Schema '${schemaName}' not found`] };
    }

    const valid = validator(data);
    
    if (!valid && validator.errors) {
      const errors = validator.errors.map((e) => 
        `${e.instancePath} ${e.message}`.trim()
      );
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Validate array items against a schema
   */
  validateArray(schemaName: string, data: unknown[]): { valid: boolean; errors?: string[] } {
    const allErrors: string[] = [];
    
    for (let i = 0; i < data.length; i++) {
      const result = this.validate(schemaName, data[i]);
      if (!result.valid && result.errors) {
        allErrors.push(...result.errors.map((e) => `[${i}] ${e}`));
      }
    }

    if (allErrors.length > 0) {
      return { valid: false, errors: allErrors };
    }

    return { valid: true };
  }

  /**
   * Get list of available schema names
   */
  getSchemaNames(): string[] {
    return Object.keys(this.spec.components?.schemas || {});
  }
}

/**
 * Map tool operations to their expected response schema
 */
export const OPERATION_SCHEMAS: Record<string, string | null> = {
  // Groups
  getApiV4Groups: 'API_Entities_Group',
  getApiV4GroupsId: 'API_Entities_Group',
  getApiV4GroupsIdProjects: 'API_Entities_BasicProjectDetails',
  getApiV4GroupsIdSubgroups: 'API_Entities_Group',
  
  // Projects
  getApiV4Projects: 'API_Entities_BasicProjectDetails',
  getApiV4ProjectsId: 'API_Entities_BasicProjectDetails',
  
  // Merge Requests
  getApiV4ProjectsIdMergeRequests: 'API_Entities_MergeRequestBasic',
  getApiV4ProjectsIdMergeRequestsMergeRequestIid: 'API_Entities_MergeRequest',
  postApiV4ProjectsIdMergeRequests: 'API_Entities_MergeRequest',
  putApiV4ProjectsIdMergeRequestsMergeRequestIid: 'API_Entities_MergeRequest',
  deleteApiV4ProjectsIdMergeRequestsMergeRequestIid: null,
  
  // Notes
  getApiV4ProjectsIdMergeRequestsMergeRequestIidNotes: 'API_Entities_Note',
  postApiV4ProjectsIdMergeRequestsMergeRequestIidNotes: 'API_Entities_Note',
  putApiV4ProjectsIdMergeRequestsMergeRequestIidNotesNoteId: 'API_Entities_Note',
  deleteApiV4ProjectsIdMergeRequestsMergeRequestIidNotesNoteId: null,
  
  // Issues
  getApiV4ProjectsIdIssues: 'API_Entities_Issue',
  getApiV4ProjectsIdIssuesIssueIid: 'API_Entities_Issue',
  postApiV4ProjectsIdIssues: 'API_Entities_Issue',
  deleteApiV4ProjectsIdIssuesIssueIid: null,
  
  // Badges
  getApiV4ProjectsIdBadges: 'API_Entities_Badge',
  getApiV4ProjectsIdBadgesBadgeId: 'API_Entities_Badge',
  postApiV4ProjectsIdBadges: 'API_Entities_Badge',
  putApiV4ProjectsIdBadgesBadgeId: 'API_Entities_Badge',
  deleteApiV4ProjectsIdBadgesBadgeId: null,
  
  // Branches
  getApiV4ProjectsIdRepositoryBranches: 'API_Entities_Branch',
  getApiV4ProjectsIdRepositoryBranchesBranch: 'API_Entities_Branch',
  postApiV4ProjectsIdRepositoryBranches: 'API_Entities_Branch',
  deleteApiV4ProjectsIdRepositoryBranchesBranch: null,
  putApiV4ProjectsIdRepositoryBranchesBranchProtect: 'API_Entities_Branch',
  putApiV4ProjectsIdRepositoryBranchesBranchUnprotect: 'API_Entities_Branch',
  
  // Access Requests
  getApiV4ProjectsIdAccessRequests: 'API_Entities_AccessRequester',
  postApiV4ProjectsIdAccessRequests: 'API_Entities_AccessRequester',
  putApiV4ProjectsIdAccessRequestsUserIdApprove: 'API_Entities_AccessRequester',
  deleteApiV4ProjectsIdAccessRequestsUserId: null,
  getApiV4GroupsIdAccessRequests: 'API_Entities_AccessRequester',
  postApiV4GroupsIdAccessRequests: 'API_Entities_AccessRequester',
  putApiV4GroupsIdAccessRequestsUserIdApprove: 'API_Entities_AccessRequester',
  deleteApiV4GroupsIdAccessRequestsUserId: null,
  
  // Jobs
  listProjectJobs: 'API_Entities_Ci_Job',
  getSingleJob: 'API_Entities_Ci_Job',
  triggerManualJob: 'API_Entities_Ci_Job',
};
