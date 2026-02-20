import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import * as nodeFs from 'node:fs';
import { createGenerator } from 'ts-json-schema-generator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFINITION_ALIASES = new Map([
  ['ToolDefinition', 'Tool'],
  ['ParameterDefinition', 'Parameter'],
  ['AuthInterceptor', 'Auth'],
  ['BaseUrlConfig', 'BaseUrl'],
  ['RateLimitConfig', 'RateLimit'],
  ['RetryConfig', 'Retry'],
  ['InterceptorConfig', 'Interceptors'],
]);

const METADATA_KEYS = new Set([
  'description',
  'examples',
  'default',
  'title',
  '$id',
]);
const PRESERVED_SCHEMA_KEYS = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'if',
  'then',
  'else',
  'not',
  'dependencies',
  'dependentRequired',
  'enum',
]);

function escapeJsonPointer(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeJsonPointer(value) {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function extractDefinitionName(rawName) {
  const importMarker = ').';
  const idx = rawName.lastIndexOf(importMarker);
  if (idx !== -1) {
    return rawName.slice(idx + importMarker.length);
  }
  return rawName;
}

function ensureUniqueName(name, usedNames) {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }

  let counter = 2;
  while (usedNames.has(`${name}${counter}`)) {
    counter += 1;
  }
  const unique = `${name}${counter}`;
  usedNames.add(unique);
  return unique;
}

function renameDefinitions(schema) {
  const definitions = schema.definitions || {};
  const renameMap = new Map();
  const usedNames = new Set();

  for (const key of Object.keys(definitions)) {
    const extracted = extractDefinitionName(key);
    const alias = DEFINITION_ALIASES.get(extracted) || extracted;
    renameMap.set(key, ensureUniqueName(alias, usedNames));
  }

  const refMap = new Map();
  for (const [oldKey, newKey] of renameMap.entries()) {
    refMap.set(`#/definitions/${escapeJsonPointer(oldKey)}`, `#/definitions/${escapeJsonPointer(newKey)}`);
  }

  const transformNode = (node) => {
    if (Array.isArray(node)) {
      return node.map(transformNode);
    }
    if (!node || typeof node !== 'object') {
      return node;
    }

    const result = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = transformNode(value);
    }

    if (typeof result.$ref === 'string' && refMap.has(result.$ref)) {
      result.$ref = refMap.get(result.$ref);
    }
    return result;
  };

  const transformedSchema = transformNode(schema);
  const renamedDefinitions = {};

  for (const [oldKey, definition] of Object.entries(definitions)) {
    const renamedKey = renameMap.get(oldKey);
    renamedDefinitions[renamedKey] = transformNode(definition);
  }

  transformedSchema.definitions = renamedDefinitions;
  return transformedSchema;
}

function overlayMetadata(target, source) {
  if (!target || !source || typeof target !== 'object' || typeof source !== 'object') {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (METADATA_KEYS.has(key)) {
      target[key] = value;
    }
    if (PRESERVED_SCHEMA_KEYS.has(key) && value !== undefined) {
      target[key] = value;
    }
  }

  const containerKeys = ['properties', 'definitions'];
  for (const key of containerKeys) {
    const targetContainer = target[key];
    const sourceContainer = source[key];
    if (!targetContainer || !sourceContainer || typeof targetContainer !== 'object' || typeof sourceContainer !== 'object') {
      continue;
    }
    for (const childKey of Object.keys(targetContainer)) {
      overlayMetadata(targetContainer[childKey], sourceContainer[childKey]);
    }
  }

  const objectKeys = ['items', 'additionalProperties'];
  for (const key of objectKeys) {
    const targetValue = target[key];
    const sourceValue = source[key];
    if (targetValue && sourceValue && typeof targetValue === 'object' && typeof sourceValue === 'object') {
      overlayMetadata(targetValue, sourceValue);
    }
  }

  const arrayKeys = ['oneOf', 'anyOf', 'allOf'];
  for (const key of arrayKeys) {
    const targetArray = target[key];
    const sourceArray = source[key];
    if (!Array.isArray(targetArray) || !Array.isArray(sourceArray)) {
      continue;
    }
    const count = Math.min(targetArray.length, sourceArray.length);
    for (let i = 0; i < count; i += 1) {
      overlayMetadata(targetArray[i], sourceArray[i]);
    }
  }
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const result = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = sortKeysDeep(value[key]);
  }
  return result;
}

function normalizeSchemaRoot(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/definitions/')) {
    return schema;
  }

  const rawRef = schema.$ref.slice('#/definitions/'.length);
  const refName = unescapeJsonPointer(rawRef);
  const rootDefinition = schema.definitions?.[refName];
  if (!rootDefinition || typeof rootDefinition !== 'object') {
    return schema;
  }

  return {
    ...rootDefinition,
    definitions: schema.definitions,
    $schema: schema.$schema,
  };
}

export function generateProfileSchemaFromTypes() {
  const generatorConfig = {
    tsconfig: path.join(PROJECT_ROOT, 'tsconfig.json'),
    type: 'Profile',
    expose: 'all',
    topRef: false,
    additionalProperties: true,
    jsDoc: 'extended',
    skipTypeCheck: true,
  };

  // Compatibility: some Node runtimes (for example Node 20) do not expose fs.globSync.
  // ts-json-schema-generator uses fs.globSync only when `path` is provided.
  if (typeof nodeFs.globSync === 'function') {
    generatorConfig.path = path.join(PROJECT_ROOT, 'src/types/profile.ts');
  }

  const parsed = createGenerator(generatorConfig).createSchema('Profile');

  if (!parsed) {
    throw new Error('Failed to generate JSON schema from Profile type');
  }

  const normalized = renameDefinitions(normalizeSchemaRoot(parsed));
  return normalized;
}

export async function readProfileSchemaFile(schemaPath = path.join(PROJECT_ROOT, 'profile-schema.json')) {
  const content = await fs.readFile(schemaPath, 'utf8');
  return JSON.parse(content);
}

export async function buildSyncedProfileSchema() {
  const generated = generateProfileSchemaFromTypes();
  const current = await readProfileSchemaFile();
  overlayMetadata(generated, current);

  // Preserve legacy/manual definitions still used by profiles and tests.
  if (current.definitions && generated.definitions) {
    for (const [key, value] of Object.entries(current.definitions)) {
      if (!(key in generated.definitions)) {
        generated.definitions[key] = value;
      }
    }
  }

  // Preserve top-level metadata for stable IDE references
  generated.$schema = current.$schema || generated.$schema;
  generated.$id = current.$id || generated.$id;
  generated.title = current.title || generated.title;
  generated.description = current.description || generated.description;

  return generated;
}

export async function writeSyncedProfileSchemaFile(outputPath = path.join(PROJECT_ROOT, 'profile-schema.json')) {
  const synced = await buildSyncedProfileSchema();
  await fs.writeFile(outputPath, `${JSON.stringify(synced, null, 2)}\n`, 'utf8');
  return synced;
}

export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}
