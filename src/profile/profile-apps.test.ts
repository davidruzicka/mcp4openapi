import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { ValidationError } from '../core/errors.js';
import type { Profile } from '../types/profile.js';
import { createLoadedProfileAppsModel, extractTemplateVariables, getNestedValue } from './profile-apps.js';

const tempPaths: string[] = [];

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-apps-'));
  const filePath = path.join(dir, name);
  tempPaths.push(dir);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

async function createParser(): Promise<OpenAPIParser> {
  const specPath = await writeTempFile('openapi.yaml', `openapi: 3.0.0
info:
  title: Apps Test API
  version: 1.0.0
servers:
  - url: http://127.0.0.1:1
paths:
  /items:
    get:
      operationId: listItems
      responses:
        '200':
          description: ok
    post:
      operationId: createItem
      responses:
        '201':
          description: created
  /items/{item_id}:
    get:
      operationId: getItem
      parameters:
        - in: path
          name: item_id
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
`);
  const parser = new OpenAPIParser();
  await parser.load(specPath);
  return parser;
}

function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    profile_name: 'apps-test',
    tools: [
      {
        name: 'get_item',
        description: 'Get item',
        parameters: {
          item_id: { type: 'string', description: 'Item id', required: true },
        },
        operations: { get: 'getItem' },
        apps: {
          output_template_resource_uri: 'ui://items/{item_id}',
          invocation_text: {
            invoking: 'Loading item',
            invoked: 'Item loaded',
          },
          custom_meta: {
            'openai/widgetDomain': 'https://widgets.example.com',
          },
        },
      },
    ],
    resources: [
      {
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: {
          variables: {
            item_id: {
              source: 'operation',
              operation: 'listItems',
              value_path: 'id',
            },
          },
        },
      },
    ],
    interceptors: {},
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
});

describe('createLoadedProfileAppsModel', () => {
  it('loads valid resources and tool apps metadata', async () => {
    const parser = await createParser();
    const profilePath = await writeTempFile('profile.json', JSON.stringify(createProfile()));

    const model = await createLoadedProfileAppsModel(createProfile(), { profilePath, parser });

    expect(model?.templateResources).toHaveLength(1);
    expect(model?.toolAppsByName.get('get_item')?.meta['openai/outputTemplate']).toBe('ui://items/{item_id}');
    expect(model?.templateResources[0].completion?.variables.item_id.operation).toBe('listItems');
  });

  it('supports explicit tool to template variable mapping', async () => {
    const parser = await createParser();
    const profile = createProfile({
      tools: [
        {
          name: 'get_item',
          description: 'Get item',
          parameters: {
            id: { type: 'string', description: 'Item id', required: true },
          },
          operations: { get: 'getItem' },
          apps: {
            output_template_resource_uri: 'ui://items/{item_id}',
            template_parameter_mapping: {
              item_id: 'id',
            },
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    const model = await createLoadedProfileAppsModel(profile, { profilePath, parser });

    expect(model?.toolAppsByName.get('get_item')?.templateParameterMapping).toEqual({ item_id: 'id' });
  });

  it('rejects duplicate resource names', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        ...createProfile().resources!,
        {
          name: 'item_template',
          kind: 'static',
          uri: 'ui://items/duplicate',
          mime_type: 'text/plain',
          inline_text: 'duplicate',
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_duplicate_name', path: 'resources[1].name' }),
    });
  });

  it('rejects duplicate resource uris', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'shell_a',
          kind: 'static',
          uri: 'ui://shell',
          mime_type: 'text/plain',
          inline_text: 'A',
        },
        {
          name: 'shell_b',
          kind: 'static',
          uri: 'ui://shell',
          mime_type: 'text/plain',
          inline_text: 'B',
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_duplicate_uri', path: 'resources[1].uri' }),
    });
  });

  it('rejects duplicate resource uri templates', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        createProfile().resources![0],
        {
          name: 'item_template_copy',
          kind: 'template',
          uri_template: 'ui://items/{item_id}',
          mime_type: 'text/html',
          inline_text: '<div>Copy</div>',
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_duplicate_uri_template', path: 'resources[1].uri_template' }),
    });
  });

  it('rejects resource content conflicts', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'conflict',
          kind: 'static',
          uri: 'ui://conflict',
          mime_type: 'text/plain',
          inline_text: 'inline',
          file_path: './conflict.txt',
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_content_conflict', path: 'resources[0]' }),
    });
  });

  it('rejects missing static content', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'missing',
          kind: 'static',
          uri: 'ui://missing',
          mime_type: 'text/plain',
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_missing_content', path: 'resources[0]' }),
    });
  });

  it('rejects oversized inline text with a typed validation error', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'too_big',
          kind: 'static',
          uri: 'ui://oversized',
          mime_type: 'text/plain',
          inline_text: 'x'.repeat(16 * 1024 + 1),
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_content_conflict', path: 'resources[0].inline_text' }),
    });
  });

  it('rejects missing files', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'missing_file',
          kind: 'static',
          uri: 'ui://missing-file',
          mime_type: 'text/plain',
          file_path: './missing.txt',
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_file_not_found', path: 'resources[0].file_path' }),
    });
  });

  it('rejects resource file paths outside the profile directory', async () => {
    const parser = await createParser();
    const outsideFile = await writeTempFile('outside.txt', 'secret');
    const profile = createProfile({
      resources: [
        {
          name: 'escaped_file',
          kind: 'static',
          uri: 'ui://escaped-file',
          mime_type: 'text/plain',
          file_path: outsideFile,
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_file_not_found', path: 'resources[0].file_path' }),
    });
  });

  it('rejects relative traversal and symlink escapes for resource file paths', async () => {
    const parser = await createParser();

    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-apps-profile-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-apps-outside-'));
    tempPaths.push(profileDir, outsideDir);

    const outsideFilePath = path.join(outsideDir, 'outside.txt');
    await fs.writeFile(outsideFilePath, 'secret', 'utf8');
    await fs.writeFile(path.join(profileDir, 'inside.txt'), 'inside', 'utf8');
    await fs.writeFile(path.join(profileDir, 'profile.json'), JSON.stringify(createProfile()), 'utf8');
    await fs.symlink(outsideFilePath, path.join(profileDir, 'escaped-link.txt'));

    const traversalProfile = createProfile({
      resources: [
        {
          name: 'traversal_file',
          kind: 'static',
          uri: 'ui://traversal-file',
          mime_type: 'text/plain',
          file_path: '../outside.txt',
        },
      ],
    });
    const traversalProfilePath = path.join(profileDir, 'profile-traversal.json');
    await fs.writeFile(traversalProfilePath, JSON.stringify(traversalProfile), 'utf8');

    await expect(createLoadedProfileAppsModel(traversalProfile, { profilePath: traversalProfilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_file_not_found', path: 'resources[0].file_path' }),
    });

    const symlinkProfile = createProfile({
      resources: [
        {
          name: 'symlink_file',
          kind: 'static',
          uri: 'ui://symlink-file',
          mime_type: 'text/plain',
          file_path: './escaped-link.txt',
        },
      ],
    });
    const symlinkProfilePath = path.join(profileDir, 'profile-symlink.json');
    await fs.writeFile(symlinkProfilePath, JSON.stringify(symlinkProfile), 'utf8');

    await expect(createLoadedProfileAppsModel(symlinkProfile, { profilePath: symlinkProfilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_file_not_found', path: 'resources[0].file_path' }),
    });
  });

  it('rejects unsupported mime types', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'binary',
          kind: 'static',
          uri: 'ui://binary',
          mime_type: 'application/pdf',
          inline_text: 'nope',
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_mime_type', path: 'resources[0].mime_type' }),
    });
  });

  it('rejects invalid fetch operation references', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'dynamic_item',
          kind: 'template',
          uri_template: 'ui://items/{item_id}',
          mime_type: 'application/json',
          fetch: {
            source: 'operation',
            operation: 'missingOperation',
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference' }),
    });
  });

  it('allows operation-backed resources without parser context during structure-only validation', async () => {
    const profile = createProfile({
      resources: [
        {
          name: 'dynamic_item',
          kind: 'template',
          uri_template: 'ui://items/{item_id}',
          mime_type: 'application/json',
          fetch: {
            source: 'operation',
            operation: 'getItem',
            parameter_mapping: { item_id: 'item_id' },
          },
          completion: {
            variables: {
              item_id: {
                source: 'operation',
                operation: 'listItems',
                value_path: 'id',
              },
            },
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    const model = await createLoadedProfileAppsModel(profile, { profilePath });
    expect(model?.templateResources[0]?.fetchStrategy?.operation).toBe('getItem');
    expect(model?.templateResources[0]?.completion?.variables.item_id.operation).toBe('listItems');
  });

  it('sanitizes user-facing validation messages for invalid file paths and URIs', async () => {
    const parser = await createParser();

    const missingFileProfile = createProfile({
      resources: [
        {
          name: 'missing_file',
          kind: 'static',
          uri: 'ui://missing-file',
          mime_type: 'text/plain',
          file_path: '../secrets/token.txt',
        },
      ],
    });
    const missingFilePath = await writeTempFile('profile-missing-file-message.json', JSON.stringify(missingFileProfile));
    await expect(createLoadedProfileAppsModel(missingFileProfile, { profilePath: missingFilePath, parser })).rejects.toMatchObject({
      message: 'Resource file_path must stay within the profile directory',
      details: expect.objectContaining({ value: '../secrets/token.txt' }),
    });

    const invalidUriProfile = createProfile({
      resources: [
        {
          name: 'bad_uri',
          kind: 'static',
          uri: 'not a uri',
          mime_type: 'text/plain',
          inline_text: 'hello',
        },
      ],
    });
    const invalidUriPath = await writeTempFile('profile-invalid-uri-message.json', JSON.stringify(invalidUriProfile));
    await expect(createLoadedProfileAppsModel(invalidUriProfile, { profilePath: invalidUriPath, parser })).rejects.toMatchObject({
      message: 'Invalid uri',
      details: expect.objectContaining({ value: 'not a uri' }),
    });

    const invalidUriTemplateProfile = createProfile({
      resources: [
        {
          name: 'bad_template',
          kind: 'template',
          uri_template: 'ui://items/{item_id',
          mime_type: 'text/html',
        },
      ],
    });
    const invalidUriTemplatePath = await writeTempFile('profile-invalid-uri-template-message.json', JSON.stringify(invalidUriTemplateProfile));
    await expect(createLoadedProfileAppsModel(invalidUriTemplateProfile, { profilePath: invalidUriTemplatePath, parser })).rejects.toMatchObject({
      message: 'Invalid uri_template',
      details: expect.objectContaining({ value: 'ui://items/{item_id' }),
    });
  });

  it('uses ValidationError for Apps validation failures', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'bad_mapping',
          kind: 'template',
          uri_template: 'ui://items/{item_id}',
          mime_type: 'text/html',
          fetch: {
            source: 'operation',
            operation: 'getItem',
            parameter_mapping: {
              item_id: 'missing',
            },
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile-bad-mapping.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects completion definitions without extraction paths', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'item_template',
          kind: 'template',
          uri_template: 'ui://items/{item_id}',
          mime_type: 'text/html',
          inline_text: '<div>Item</div>',
          completion: {
            variables: {
              item_id: {
                source: 'operation',
                operation: 'listItems',
              },
            },
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id' }),
    });
  });

  it('rejects invalid completion parameter mappings', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'item_template',
          kind: 'template',
          uri_template: 'ui://items/{item_id}',
          mime_type: 'text/html',
          inline_text: '<div>Item</div>',
          completion: {
            variables: {
              item_id: {
                source: 'operation',
                operation: 'listItems',
                value_path: 'id',
                parameter_mapping: {
                  item_id: 'missing_variable',
                },
              },
            },
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.parameter_mapping.item_id' }),
    });
  });

  it('rejects tools that reference unknown Apps resources', async () => {
    const parser = await createParser();
    const profile = createProfile({
      tools: [
        {
          ...createProfile().tools[0],
          apps: {
            output_template_resource_uri: 'ui://missing',
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_tool_missing_resource_reference', path: 'tools[0].apps.output_template_resource_uri' }),
    });
  });

  it('rejects explicit mappings that reference unknown tool parameters', async () => {
    const parser = await createParser();
    const profile = createProfile({
      tools: [
        {
          name: 'get_item',
          description: 'Get item',
          parameters: {
            item_id: { type: 'string', description: 'Item id', required: true },
          },
          operations: { get: 'getItem' },
          apps: {
            output_template_resource_uri: 'ui://items/{item_id}',
            template_parameter_mapping: {
              item_id: 'missing_param',
            },
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_tool_invalid_template_mapping', path: 'tools[0].apps.template_parameter_mapping.item_id' }),
    });
  });

  it('rejects missing static resource uri and template uri_template', async () => {
    const parser = await createParser();

    const staticProfile = createProfile({
      resources: [{ name: 'broken_static', kind: 'static', mime_type: 'text/plain', inline_text: 'hi' }],
    });
    const staticProfilePath = await writeTempFile('profile-static.json', JSON.stringify(staticProfile));
    await expect(createLoadedProfileAppsModel(staticProfile, { profilePath: staticProfilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_missing_content', path: 'resources[0].uri' }),
    });

    const templateProfile = createProfile({
      resources: [{ name: 'broken_template', kind: 'template', mime_type: 'text/plain', inline_text: 'hi' }],
    });
    const templateProfilePath = await writeTempFile('profile-template.json', JSON.stringify(templateProfile));
    await expect(createLoadedProfileAppsModel(templateProfile, { profilePath: templateProfilePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_missing_content', path: 'resources[0].uri_template' }),
    });
  });

  it('loads file-backed resources and normalizes resource apps metadata', async () => {
    const parser = await createParser();
    const resourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-apps-resource-'));
    tempPaths.push(resourceDir);
    const profilePath = path.join(resourceDir, 'profile.json');
    await fs.writeFile(path.join(resourceDir, 'shell.html'), '<div>Shell</div>', 'utf8');

    const profile = createProfile({
      tools: [],
      resources: [
        {
          name: 'shell',
          kind: 'static',
          uri: 'ui://shell',
          mime_type: 'text/html',
          file_path: './shell.html',
          apps: {
            widget_description: 'Shell widget',
            widget_prefers_border: true,
            widget_csp: { connect_domains: ['https://widgets.example.com'], resource_domains: [] },
            custom_meta: { custom: 'meta' },
          },
        },
      ],
    });
    await fs.writeFile(profilePath, JSON.stringify(profile), 'utf8');

    const model = await createLoadedProfileAppsModel(profile, { profilePath, parser });

    expect(model?.fixedResources[0]).toMatchObject({
      text: '<div>Shell</div>',
      appsMeta: {
        'openai/widgetDescription': 'Shell widget',
        'openai/widgetPrefersBorder': true,
        'openai/widgetCSP': { connect_domains: ['https://widgets.example.com'], resource_domains: [] },
        custom: 'meta',
      },
    });
  });

  it('rejects readonly violations and missing references for fetch and completion strategies', async () => {
    const parser = await createParser();

    const fetchMissingOperationProfile = createProfile({
      resources: [{
        name: 'dynamic_item',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: { source: 'operation', parameter_mapping: { item_id: 'item_id' } },
      }],
    });
    const fetchMissingOperationPath = await writeTempFile('profile-fetch-missing-op.json', JSON.stringify(fetchMissingOperationProfile));
    await expect(createLoadedProfileAppsModel(fetchMissingOperationProfile, { profilePath: fetchMissingOperationPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference', path: 'resources[0].fetch.operation' }),
    });

    const fetchWriteOperationProfile = createProfile({
      resources: [{
        name: 'dynamic_item',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: { source: 'operation', operation: 'createItem', parameter_mapping: { item_id: 'item_id' } },
      }],
    });
    const fetchWriteOperationPath = await writeTempFile('profile-fetch-write-op.json', JSON.stringify(fetchWriteOperationProfile));
    await expect(createLoadedProfileAppsModel(fetchWriteOperationProfile, { profilePath: fetchWriteOperationPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference', path: 'resources[0].fetch.operation' }),
    });

    const completionMissingOperationProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'operation', value_path: 'id' } } },
      }],
    });
    const completionMissingOperationPath = await writeTempFile('profile-completion-missing-op.json', JSON.stringify(completionMissingOperationProfile));
    await expect(createLoadedProfileAppsModel(completionMissingOperationProfile, { profilePath: completionMissingOperationPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.operation' }),
    });

    const completionWriteOperationProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'operation', operation: 'createItem', value_path: 'id' } } },
      }],
    });
    const completionWriteOperationPath = await writeTempFile('profile-completion-write-op.json', JSON.stringify(completionWriteOperationProfile));
    await expect(createLoadedProfileAppsModel(completionWriteOperationProfile, { profilePath: completionWriteOperationPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.operation' }),
    });
  });

  it('rejects composite-backed fetch and completion configurations that are missing required composite metadata', async () => {
    const parser = await createParser();
    const compositeTool = {
      name: 'read_item_view',
      description: 'Read item view',
      composite: true,
      parameters: {
        item_id: { type: 'string', description: 'Item id', required: true },
      },
      steps: [{ call: 'GET /items/{item_id}', store_as: 'item' }],
    } as Profile['tools'][number];
    const writeCompositeTool = {
      ...compositeTool,
      name: 'write_item_view',
      steps: [{ call: 'POST /items', store_as: 'item' }],
    } as Profile['tools'][number];

    const missingFetchCompositeProfile = createProfile({
      tools: [createProfile().tools[0], compositeTool],
      resources: [{
        name: 'dynamic_item',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: { source: 'composite', parameter_mapping: { item_id: 'item_id' } },
      }],
    });
    const missingFetchCompositePath = await writeTempFile('profile-fetch-missing-composite.json', JSON.stringify(missingFetchCompositeProfile));
    await expect(createLoadedProfileAppsModel(missingFetchCompositeProfile, { profilePath: missingFetchCompositePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference', path: 'resources[0].fetch.composite_tool' }),
    });

    const writeFetchCompositeProfile = createProfile({
      tools: [createProfile().tools[0], writeCompositeTool],
      resources: [{
        name: 'dynamic_item',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: { source: 'composite', composite_tool: 'write_item_view', parameter_mapping: { item_id: 'item_id' } },
      }],
    });
    const writeFetchCompositePath = await writeTempFile('profile-fetch-write-composite.json', JSON.stringify(writeFetchCompositeProfile));
    await expect(createLoadedProfileAppsModel(writeFetchCompositeProfile, { profilePath: writeFetchCompositePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference', path: 'resources[0].fetch.composite_tool' }),
    });

    const missingCompletionCompositeProfile = createProfile({
      tools: [createProfile().tools[0], compositeTool],
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'composite_tool', value_path: 'id' } } },
      }],
    });
    const missingCompletionCompositePath = await writeTempFile('profile-completion-missing-composite.json', JSON.stringify(missingCompletionCompositeProfile));
    await expect(createLoadedProfileAppsModel(missingCompletionCompositeProfile, { profilePath: missingCompletionCompositePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.composite_tool' }),
    });

    const writeCompletionCompositeProfile = createProfile({
      tools: [createProfile().tools[0], writeCompositeTool],
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'composite_tool', composite_tool: 'write_item_view', value_path: 'id' } } },
      }],
    });
    const writeCompletionCompositePath = await writeTempFile('profile-completion-write-composite.json', JSON.stringify(writeCompletionCompositeProfile));
    await expect(createLoadedProfileAppsModel(writeCompletionCompositeProfile, { profilePath: writeCompletionCompositePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.composite_tool' }),
    });
  });

  it('rejects invalid static completion values and unsupported template variable mappings', async () => {
    const parser = await createParser();

    const duplicateStaticCompletionProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'static', values: ['1', '1'] } } },
      }],
    });
    const duplicateStaticCompletionPath = await writeTempFile('profile-static-completion-duplicate.json', JSON.stringify(duplicateStaticCompletionProfile));
    await expect(createLoadedProfileAppsModel(duplicateStaticCompletionProfile, { profilePath: duplicateStaticCompletionPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.values' }),
    });

    const longStaticCompletionProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'static', values: ['x'.repeat(257)] } } },
      }],
    });
    const longStaticCompletionPath = await writeTempFile('profile-static-completion-long.json', JSON.stringify(longStaticCompletionProfile));
    await expect(createLoadedProfileAppsModel(longStaticCompletionProfile, { profilePath: longStaticCompletionPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.values' }),
    });

    const unknownCompletionVariableProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { category_id: { source: 'static', values: ['a'] } } },
      }],
    });
    const unknownCompletionVariablePath = await writeTempFile('profile-completion-unknown-variable.json', JSON.stringify(unknownCompletionVariableProfile));
    await expect(createLoadedProfileAppsModel(unknownCompletionVariableProfile, { profilePath: unknownCompletionVariablePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.category_id' }),
    });

    const unknownTemplateMappingProfile = createProfile({
      tools: [{
        ...createProfile().tools[0],
        apps: {
          output_template_resource_uri: 'ui://items/{item_id}',
          template_parameter_mapping: { other_id: 'item_id' },
        },
      }],
    });
    const unknownTemplateMappingPath = await writeTempFile('profile-template-mapping-unknown-variable.json', JSON.stringify(unknownTemplateMappingProfile));
    await expect(createLoadedProfileAppsModel(unknownTemplateMappingProfile, { profilePath: unknownTemplateMappingPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_tool_invalid_template_mapping', path: 'tools[0].apps.template_parameter_mapping.other_id' }),
    });
  });

  it('uses parameter aliases to infer template parameter mappings', async () => {
    const parser = await createParser();
    const profile = createProfile({
      parameter_aliases: {
        item_id: ['id'],
      },
      tools: [{
        name: 'get_item',
        description: 'Get item',
        parameters: {
          id: { type: 'string', description: 'Item id', required: true },
        },
        operations: { get: 'getItem' },
        apps: {
          output_template_resource_uri: 'ui://items/{item_id}',
        },
      }],
    });
    const profilePath = await writeTempFile('profile-alias.json', JSON.stringify(profile));

    const model = await createLoadedProfileAppsModel(profile, { profilePath, parser });

    expect(model?.toolAppsByName.get('get_item')?.templateParameterMapping).toBeUndefined();
    expect(model?.toolAppsByName.get('get_item')?.outputTemplateResourceName).toBe('item_template');
  });

  it('covers remaining apps model validation and helper branches', async () => {
    const parser = await createParser();

    const noAppsProfile = createProfile({
      tools: [{ ...createProfile().tools[0], apps: undefined }],
      resources: [],
    });
    const noAppsProfilePath = await writeTempFile('profile-no-apps.json', JSON.stringify(noAppsProfile));
    await expect(createLoadedProfileAppsModel(noAppsProfile, { profilePath: noAppsProfilePath, parser })).resolves.toBeUndefined();

    const templateWithoutContentProfile = createProfile({
      tools: [{ ...createProfile().tools[0], apps: undefined }],
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
      }],
    });
    const templateWithoutContentPath = await writeTempFile('profile-template-no-content.json', JSON.stringify(templateWithoutContentProfile));
    const templateWithoutContentModel = await createLoadedProfileAppsModel(templateWithoutContentProfile, {
      profilePath: templateWithoutContentPath,
      parser,
    });
    expect(templateWithoutContentModel?.templateResources[0]).toMatchObject({
      staticText: undefined,
      fetchStrategy: undefined,
    });

    const staticCompletionProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        completion: { variables: { item_id: { source: 'static', values: ['1', '2'] } } },
      }],
      tools: [{
        ...createProfile().tools[0],
        apps: {
          output_template_resource_uri: 'ui://items/{item_id}',
          widget_accessible: false,
          tool_invocation_message: {
            invoking: 'Preparing widget',
            invoked: 'Widget ready',
          },
        },
      }],
    });
    const staticCompletionPath = await writeTempFile('profile-static-completion-success.json', JSON.stringify(staticCompletionProfile));
    const staticCompletionModel = await createLoadedProfileAppsModel(staticCompletionProfile, { profilePath: staticCompletionPath, parser });
    expect(staticCompletionModel?.templateResources[0].completion?.variables.item_id).toMatchObject({
      source: 'static',
      values: ['1', '2'],
      parameterMapping: {},
    });
    expect(staticCompletionModel?.toolAppsByName.get('get_item')?.meta).toMatchObject({
      'openai/outputTemplate': 'ui://items/{item_id}',
      'openai/widgetAccessible': false,
      'openai/toolInvocation/invoking': 'Preparing widget',
      'openai/toolInvocation/invoked': 'Widget ready',
    });

    const unknownFetchCompositeProfile = createProfile({
      tools: [
        { ...createProfile().tools[0], apps: undefined },
        { name: 'plain_tool', description: 'Plain', parameters: {}, operations: { execute: 'getItem' } },
      ],
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: { source: 'composite', composite_tool: 'plain_tool', parameter_mapping: { item_id: 'item_id' } },
      }],
    });
    const unknownFetchCompositePath = await writeTempFile('profile-fetch-unknown-composite.json', JSON.stringify(unknownFetchCompositeProfile));
    await expect(createLoadedProfileAppsModel(unknownFetchCompositeProfile, { profilePath: unknownFetchCompositePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference', path: 'resources[0].fetch.composite_tool' }),
    });

    const unknownOperationCompletionProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'operation', operation: 'missingOperation', value_path: 'id' } } },
      }],
    });
    const unknownOperationCompletionPath = await writeTempFile('profile-completion-unknown-operation.json', JSON.stringify(unknownOperationCompletionProfile));
    await expect(createLoadedProfileAppsModel(unknownOperationCompletionProfile, { profilePath: unknownOperationCompletionPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.operation' }),
    });

    const unknownCompositeCompletionProfile = createProfile({
      tools: [
        { ...createProfile().tools[0], apps: undefined },
        { name: 'plain_tool', description: 'Plain', parameters: {}, operations: { execute: 'getItem' } },
      ],
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        inline_text: '<div>Item</div>',
        completion: { variables: { item_id: { source: 'composite_tool', composite_tool: 'plain_tool', value_path: 'id' } } },
      }],
    });
    const unknownCompositeCompletionPath = await writeTempFile('profile-completion-unknown-composite.json', JSON.stringify(unknownCompositeCompletionProfile));
    await expect(createLoadedProfileAppsModel(unknownCompositeCompletionProfile, { profilePath: unknownCompositeCompletionPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_completion_definition', path: 'resources[0].completion.variables.item_id.composite_tool' }),
    });

    const missingDerivedMappingProfile = createProfile({
      tools: [{
        ...createProfile().tools[0],
        parameters: {
          category_id: { type: 'string', description: 'Category id', required: true },
        },
        apps: { output_template_resource_uri: 'ui://items/{item_id}' },
      }],
    });
    const missingDerivedMappingPath = await writeTempFile('profile-template-mapping-missing-derived.json', JSON.stringify(missingDerivedMappingProfile));
    await expect(createLoadedProfileAppsModel(missingDerivedMappingProfile, { profilePath: missingDerivedMappingPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_tool_invalid_template_mapping', path: 'tools[0].apps.output_template_resource_uri' }),
    });

    const invalidResultPathProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: { source: 'operation', operation: 'getItem', parameter_mapping: { item_id: 'item_id' }, result_path: 'bad-path' },
      }],
    });
    const invalidResultPath = await writeTempFile('profile-invalid-result-path.json', JSON.stringify(invalidResultPathProfile));
    await expect(createLoadedProfileAppsModel(invalidResultPathProfile, { profilePath: invalidResultPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference', path: 'resources[0].fetch.result_path' }),
    });

    const longResultPathProfile = createProfile({
      resources: [{
        name: 'item_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}',
        mime_type: 'text/html',
        fetch: { source: 'operation', operation: 'getItem', parameter_mapping: { item_id: 'item_id' }, result_path: `a.${'b'.repeat(256)}` },
      }],
    });
    const longResultPath = await writeTempFile('profile-long-result-path.json', JSON.stringify(longResultPathProfile));
    await expect(createLoadedProfileAppsModel(longResultPathProfile, { profilePath: longResultPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_fetch_reference', path: 'resources[0].fetch.result_path' }),
    });

    const invalidUriProfile = createProfile({
      resources: [{
        name: 'bad_uri',
        kind: 'static',
        uri: 'not a uri',
        mime_type: 'text/plain',
        inline_text: 'hello',
      }],
    });
    const invalidUriPath = await writeTempFile('profile-invalid-uri.json', JSON.stringify(invalidUriProfile));
    await expect(createLoadedProfileAppsModel(invalidUriProfile, { profilePath: invalidUriPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_uri', path: 'resources[0].uri' }),
    });

    const duplicateTemplateVariableProfile = createProfile({
      resources: [{
        name: 'bad_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id}/{item_id}',
        mime_type: 'text/html',
      }],
    });
    const duplicateTemplateVariablePath = await writeTempFile('profile-duplicate-template-variable.json', JSON.stringify(duplicateTemplateVariableProfile));
    await expect(createLoadedProfileAppsModel(duplicateTemplateVariableProfile, { profilePath: duplicateTemplateVariablePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_uri_template', path: 'resources[0].uri_template' }),
    });

    const unmatchedBraceProfile = createProfile({
      resources: [{
        name: 'bad_template',
        kind: 'template',
        uri_template: 'ui://items/{item_id',
        mime_type: 'text/html',
      }],
    });
    const unmatchedBracePath = await writeTempFile('profile-unmatched-brace-template.json', JSON.stringify(unmatchedBraceProfile));
    await expect(createLoadedProfileAppsModel(unmatchedBraceProfile, { profilePath: unmatchedBracePath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_resource_invalid_uri_template', path: 'resources[0].uri_template' }),
    });

    const longInvocationProfile = createProfile({
      tools: [{
        ...createProfile().tools[0],
        apps: {
          output_template_resource_uri: 'ui://items/{item_id}',
          invocation_text: { invoking: 'x'.repeat(81), invoked: 'done' },
        },
      }],
    });
    const longInvocationPath = await writeTempFile('profile-long-invocation.json', JSON.stringify(longInvocationProfile));
    await expect(createLoadedProfileAppsModel(longInvocationProfile, { profilePath: longInvocationPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_tool_invalid_invocation_text', path: 'tools[0].apps.invoking' }),
    });

    const nonSerializableToolProfile = createProfile({
      tools: [{
        ...createProfile().tools[0],
        apps: {
          output_template_resource_uri: 'ui://items/{item_id}',
          custom_meta: { bad: BigInt(1) as unknown as number },
        },
      }],
    });
    const nonSerializableToolPath = await writeTempFile('profile-non-serializable-tool-meta.json', '{}');
    await expect(createLoadedProfileAppsModel(nonSerializableToolProfile, { profilePath: nonSerializableToolPath, parser })).rejects.toMatchObject({
      details: expect.objectContaining({ code: 'apps_tool_invalid_invocation_text', path: 'tools[0].apps.custom_meta' }),
    });

    const template = templateWithoutContentModel!.templateResources[0];
    expect(extractTemplateVariables(template, 'ui://items/alpha%20beta')).toEqual({ item_id: 'alpha beta' });
    expect(getNestedValue({ item: [{ id: '1' }] }, 'item.id')).toBeUndefined();
  });

  it('uses ValidationError for Apps validation failures', async () => {
    const parser = await createParser();
    const profile = createProfile({
      resources: [
        {
          name: 'bad_mapping',
          kind: 'template',
          uri_template: 'ui://items/{item_id}',
          mime_type: 'text/html',
          fetch: {
            source: 'operation',
            operation: 'getItem',
            parameter_mapping: { item_id: 'missing' },
          },
        },
      ],
    });
    const profilePath = await writeTempFile('profile.json', JSON.stringify(profile));

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toBeInstanceOf(ValidationError);
  });
});
