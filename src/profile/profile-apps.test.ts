import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { ValidationError } from '../core/errors.js';
import type { Profile } from '../types/profile.js';
import { createLoadedProfileAppsModel } from './profile-apps.js';

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

  it('rejects oversized inline text', async () => {
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

    await expect(createLoadedProfileAppsModel(profile, { profilePath, parser })).rejects.toBeInstanceOf(ValidationError);
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
});
