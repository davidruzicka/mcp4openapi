/**
 * OpenAPI operational types
 * 
 * Why simplified: We only need subset of OpenAPI spec for our use case
 * (operation lookup, parameter extraction, request building). Full OpenAPI
 * types from openapi-types are too verbose for runtime usage.
 */

import type { OpenAPIV3 } from 'openapi-types';

export interface OpenAPIIndex {
  spec: OpenAPIV3.Document;
  operations: Map<string, OperationInfo>;
  paths: Map<string, PathInfo>;
}

export interface OperationInfo {
  operationId: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters: ParameterInfo[];
  requestBody?: RequestBodyInfo;
  tags?: string[];
}

export interface PathInfo {
  path: string;
  operations: Record<string, OperationInfo>;
}

export interface ParameterInfo {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  schema: SchemaInfo;
  description?: string;
}

export interface RequestBodyInfo {
  required: boolean;
  content: Record<string, { schema: SchemaInfo }>;
}

export interface SchemaInfo {
  type?: string;
  format?: string;
  enum?: unknown[];
  items?: SchemaInfo;
  properties?: Record<string, SchemaInfo>;
  required?: string[];
  default?: unknown;
  ref?: string;
  circular?: boolean;
  allOf?: SchemaInfo[];
  anyOf?: SchemaInfo[];
  oneOf?: SchemaInfo[];
}

