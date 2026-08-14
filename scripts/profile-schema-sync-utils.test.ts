import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildSyncedProfileSchema,
  generateProfileSchemaFromTypes,
  pruneUnreachableDefinitions,
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

describe('pruneUnreachableDefinitions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps definitions reachable from the root, including transitively and via encoded refs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: {
        direct: { $ref: '#/definitions/Direct' },
        encoded: { $ref: '#/definitions/Record%3Cstring%2Cstring%3E' },
      },
      definitions: {
        Direct: { type: 'object', properties: { nested: { $ref: '#/definitions/Transitive' } } },
        Transitive: { type: 'string' },
        'Record<string,string>': { type: 'object' },
      },
    } as any;

    pruneUnreachableDefinitions(schema);

    expect(Object.keys(schema.definitions).sort()).toEqual([
      'Direct',
      'Record<string,string>',
      'Transitive',
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops unreachable definitions and warns with their names', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schema = {
      type: 'object',
      properties: { kept: { $ref: '#/definitions/Kept' } },
      definitions: {
        Kept: { type: 'string' },
        OrphanConfig: { type: 'object' },
        // Orphans referencing each other must not keep each other alive.
        OrphanA: { $ref: '#/definitions/OrphanB' },
        OrphanB: { type: 'string' },
      },
    } as any;

    pruneUnreachableDefinitions(schema);

    expect(Object.keys(schema.definitions)).toEqual(['Kept']);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('dropping 3 definition(s)');
    expect(message).toContain('OrphanConfig');
    expect(message).toContain('OrphanA');
    expect(message).toContain('OrphanB');
  });

  it('builds a synced schema with every definition reachable from the root', async () => {
    const synced = (await buildSyncedProfileSchema()) as any;
    const before = Object.keys(synced.definitions).sort();
    pruneUnreachableDefinitions(synced);
    expect(Object.keys(synced.definitions).sort()).toEqual(before);
  });
});
