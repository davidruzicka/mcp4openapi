import { describe, expect, it } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { composeToolDescriptor } from './tool-app-descriptor.js';
import type { LoadedProfileAppsModel } from '../profile/profile-apps.js';
import type { ToolDefinition } from '../types/profile.js';

const baseTool: Tool = {
  name: 'get_item',
  description: 'Get item',
  inputSchema: { type: 'object', properties: {} },
};

const toolDef: ToolDefinition = {
  name: 'get_item',
  description: 'Get item',
  parameters: {},
  operations: { get: 'getItem' },
  apps: {
    output_template_resource_uri: 'ui://items/{item_id}',
    annotations: { title: 'Widget tool', readOnlyHint: true },
  },
};

describe('composeToolDescriptor', () => {
  it('returns the base tool unchanged without apps metadata', () => {
    expect(composeToolDescriptor(baseTool, { ...toolDef, apps: undefined }, undefined)).toEqual(baseTool);
  });

  it('returns the base tool unchanged when no binding exists for the tool', () => {
    const appsModel = {
      fixedResources: [],
      templateResources: [],
      resourcesByUri: new Map(),
      templateResourcesByName: new Map(),
      templateResourcesByUriTemplate: new Map(),
      toolAppsByName: new Map(),
    } as unknown as LoadedProfileAppsModel;

    expect(composeToolDescriptor(baseTool, toolDef, appsModel)).toEqual(baseTool);
  });

  it('merges apps annotations and meta', () => {
    const appsModel = {
      fixedResources: [],
      templateResources: [],
      resourcesByUri: new Map(),
      templateResourcesByName: new Map(),
      templateResourcesByUriTemplate: new Map(),
      toolAppsByName: new Map([
        ['get_item', { outputTemplateResourceUri: 'ui://items/{item_id}', meta: { 'openai/outputTemplate': 'ui://items/{item_id}' }, annotations: { title: 'Widget tool', readOnlyHint: true } }],
      ]),
    } as unknown as LoadedProfileAppsModel;

    const descriptor = composeToolDescriptor(baseTool, toolDef, appsModel);

    expect(descriptor._meta).toEqual({ 'openai/outputTemplate': 'ui://items/{item_id}' });
    expect(descriptor.annotations).toEqual({ title: 'Widget tool', readOnlyHint: true });
  });

  it('preserves existing annotations when binding has no annotation overrides', () => {
    const appsModel = {
      fixedResources: [],
      templateResources: [],
      resourcesByUri: new Map(),
      templateResourcesByName: new Map(),
      templateResourcesByUriTemplate: new Map(),
      toolAppsByName: new Map([
        ['get_item', { outputTemplateResourceUri: 'ui://items/{item_id}', meta: { 'openai/outputTemplate': 'ui://items/{item_id}' } }],
      ]),
    } as unknown as LoadedProfileAppsModel;

    const descriptor = composeToolDescriptor({ ...baseTool, annotations: { audience: ['user'] } }, toolDef, appsModel);

    expect(descriptor.annotations).toEqual({ audience: ['user'] });
    expect(descriptor._meta).toEqual({ 'openai/outputTemplate': 'ui://items/{item_id}' });
  });
});
