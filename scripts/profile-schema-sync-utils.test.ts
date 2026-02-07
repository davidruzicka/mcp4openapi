import { describe, it, expect } from 'vitest';
import {
  buildSyncedProfileSchema,
  generateProfileSchemaFromTypes,
  readProfileSchemaFile,
  stableStringify,
} from './profile-schema-sync-utils.js';

describe('profile-schema-sync-utils', () => {
  it('generates JSON schema from Profile type with expected shape', () => {
    const generated = generateProfileSchemaFromTypes() as any;

    expect(generated).toBeDefined();
    expect(generated.type).toBe('object');
    expect(Array.isArray(generated.required)).toBe(true);
    expect(generated.required).toContain('profile_name');
    expect(generated.required).toContain('tools');
    expect(generated.definitions).toBeDefined();
    expect(generated.definitions).toHaveProperty('Tool');
    const hasParameterDefinition = Object.prototype.hasOwnProperty.call(generated.definitions, 'Parameter')
      || Object.prototype.hasOwnProperty.call(generated.definitions, 'Record<string,ParameterDefinition>');
    expect(hasParameterDefinition).toBe(true);
  });

  it('builds synchronized schema preserving core metadata fields', async () => {
    const current = await readProfileSchemaFile() as any;
    const synced = await buildSyncedProfileSchema() as any;

    expect(synced.$schema).toBe(current.$schema);
    expect(synced.$id).toBe(current.$id);
    expect(synced.title).toBe(current.title);
    expect(synced.description).toBe(current.description);
  });

  it('stableStringify is order-insensitive for object keys', () => {
    const a = { z: 1, nested: { b: 2, a: 1 } };
    const b = { nested: { a: 1, b: 2 }, z: 1 };

    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});
