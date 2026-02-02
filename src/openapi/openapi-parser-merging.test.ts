import { describe, it, expect } from 'vitest';
import { OpenAPIParser } from './openapi-parser.js';
import type { SchemaInfo } from '../types/openapi.js';

describe('OpenAPIParser Merging', () => {
  // Access private method via any cast for testing internal logic
  const parser = new OpenAPIParser();
  const mergeSchemaInfo = (target: SchemaInfo, source: SchemaInfo) => (parser as any).mergeSchemaInfo(target, source);

  it('merges minLength (strictest/max wins)', () => {
    const target: SchemaInfo = { minLength: 5 };
    const source: SchemaInfo = { minLength: 10 };
    mergeSchemaInfo(target, source);
    expect(target.minLength).toBe(10);

    const target2: SchemaInfo = { minLength: 10 };
    const source2: SchemaInfo = { minLength: 5 };
    mergeSchemaInfo(target2, source2);
    expect(target2.minLength).toBe(10);

    const target3: SchemaInfo = {};
    const source3: SchemaInfo = { minLength: 5 };
    mergeSchemaInfo(target3, source3);
    expect(target3.minLength).toBe(5);
  });

  it('merges maxLength (strictest/min wins)', () => {
    const target: SchemaInfo = { maxLength: 10 };
    const source: SchemaInfo = { maxLength: 5 };
    mergeSchemaInfo(target, source);
    expect(target.maxLength).toBe(5);

    const target2: SchemaInfo = { maxLength: 5 };
    const source2: SchemaInfo = { maxLength: 10 };
    mergeSchemaInfo(target2, source2);
    expect(target2.maxLength).toBe(5);

    const target3: SchemaInfo = {};
    const source3: SchemaInfo = { maxLength: 5 };
    mergeSchemaInfo(target3, source3);
    expect(target3.maxLength).toBe(5);
  });

  it('merges patterns (combines with lookahead)', () => {
    const target: SchemaInfo = { pattern: '^[a-z]+$' };
    const source: SchemaInfo = { pattern: '.{5,}' };
    mergeSchemaInfo(target, source);
    expect(target.pattern).toBe('^(?=[\\s\\S]*^[a-z]+$)(?=[\\s\\S]*.{5,})[\\s\\S]*$');

    const target2: SchemaInfo = {};
    const source2: SchemaInfo = { pattern: '^[0-9]+$' };
    mergeSchemaInfo(target2, source2);
    expect(target2.pattern).toBe('^[0-9]+$');
  });

  it('merges other fields correctly', () => {
    const target: SchemaInfo = {};
    const source: SchemaInfo = {
        type: 'string',
        format: 'email',
        enum: ['a', 'b'],
        default: 'a',
        required: ['field1']
    };
    mergeSchemaInfo(target, source);
    expect(target.type).toBe('string');
    expect(target.format).toBe('email');
    expect(target.enum).toEqual(['a', 'b']);
    expect(target.default).toBe('a');
    expect(target.required).toEqual(['field1']);
  });
});
