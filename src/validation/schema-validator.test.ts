/**
 * Schema validator tests
 */

import { describe, it, expect } from 'vitest';
import { SchemaValidator } from './schema-validator.js';
import type { OperationInfo } from '../types/openapi.js';

describe('SchemaValidator', () => {
  const validator = new SchemaValidator();

  it('passes when no schema is defined', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
    };

    const result = validator.validateRequestBody(operation, { key: 'value' });
    expect(result.valid).toBe(true);
  });

  it('validates simple string type', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
            },
          },
        },
      },
    };

    const result = validator.validateRequestBody(operation, { name: 'test' });
    expect(result.valid).toBe(true);
  });

  it('detects type mismatch', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                age: { type: 'number' },
              },
            },
          },
        },
      },
    };

    const result = validator.validateRequestBody(operation, { age: 'not a number' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].path).toBe('age');
    expect(result.errors![0].message).toContain('Expected number');
  });

  it('detects missing required fields', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string' },
              },
              required: ['name', 'email'],
            },
          },
        },
      },
    };

    const result = validator.validateRequestBody(operation, { name: 'John' });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].path).toBe('email');
    expect(result.errors![0].message).toContain('Required property is missing');
  });

  it('validates enum values', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['active', 'inactive'] },
              },
            },
          },
        },
      },
    };

    const validResult = validator.validateRequestBody(operation, { status: 'active' });
    expect(validResult.valid).toBe(true);

    const invalidResult = validator.validateRequestBody(operation, { status: 'unknown' });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors![0].message).toContain('must be one of');
  });

  it('validates nested objects', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                user: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    age: { type: 'number' },
                  },
                  required: ['name'],
                },
              },
            },
          },
        },
      },
    };

    const result = validator.validateRequestBody(operation, {
      user: { age: 25 },
    });
    expect(result.valid).toBe(false);
    expect(result.errors![0].path).toBe('user.name');
  });

  it('validates arrays', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      },
    };

    const validResult = validator.validateRequestBody(operation, {
      tags: ['tag1', 'tag2'],
    });
    expect(validResult.valid).toBe(true);

    const invalidResult = validator.validateRequestBody(operation, {
      tags: ['tag1', 123],
    });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors![0].path).toBe('tags[1]');
  });

  it('validates root array bodies', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                },
                required: ['email'],
              },
            },
          },
        },
      },
    };

    const validResult = validator.validateRequestBody(operation, [
      { email: 'test@example.com' },
    ]);
    expect(validResult.valid).toBe(true);

    const invalidResult = validator.validateRequestBody(operation, [
      { email: 'not-an-email' },
    ]);
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors![0].path).toBe('[0].email');
  });

  it('validates email format', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                email: { type: 'string', format: 'email' },
              },
            },
          },
        },
      },
    };

    const validResult = validator.validateRequestBody(operation, {
      email: 'test@example.com',
    });
    expect(validResult.valid).toBe(true);

    const invalidResult = validator.validateRequestBody(operation, {
      email: 'not-an-email',
    });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors![0].message).toContain('email format');
  });

  it('validates URI format', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                url: { type: 'string', format: 'uri' },
              },
            },
          },
        },
      },
    };

    const validResult = validator.validateRequestBody(operation, {
      url: 'https://example.com',
    });
    expect(validResult.valid).toBe(true);

    const invalidResult = validator.validateRequestBody(operation, {
      url: 'not a url',
    });
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.errors![0].message).toContain('URI format');

    const dangerousResult = validator.validateRequestBody(operation, {
      url: 'javascript:alert(1)',
    });
    expect(dangerousResult.valid).toBe(false);
    expect(dangerousResult.errors![0].message).toContain('URI format');
  });

  it('validates null value against non-null schema', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
      },
    };

    const result = validator.validateRequestBody(operation, { name: null });
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toContain('Expected string');
  });

  it('validates undefined value against required field', () => {
    const operation: OperationInfo = {
      operationId: 'test',
      method: 'POST',
      path: '/test',
      parameters: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
              },
              required: ['name'],
            },
          },
        },
      },
    };

    const result = validator.validateRequestBody(operation, {});
    expect(result.valid).toBe(false);
    expect(result.errors![0].message).toContain('Required');
  });
});
