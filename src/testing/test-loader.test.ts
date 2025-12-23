import { describe, expect, it } from 'vitest';
import { validateTestAgainstProfile } from './test-loader.js';
import { Profile } from '../types/profile.js';
import { ProfileTestDefinition } from './test-schema.js';

const baseProfile: Profile = {
  profile_name: 'demo',
  tools: [
    {
      name: 'manage_items',
      description: 'Manage demo items',
      operations: {
        create: 'createItem',
        delete: 'deleteItem'
      },
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['create', 'delete'],
          description: 'Action to perform'
        },
        id: {
          type: 'string',
          description: 'Item identifier',
          required_for: ['delete']
        }
      }
    }
  ]
};

describe('validateTestAgainstProfile', () => {
  it('passes when all operations are covered', () => {
    const testDef: ProfileTestDefinition = {
      profile_name: 'demo',
      scenarios: [
        {
          name: 'create item',
          tool: 'manage_items',
          arguments: { action: 'create' },
          expect: { success: true }
        },
        {
          name: 'delete item',
          tool: 'manage_items',
          arguments: { action: 'delete', id: '1' },
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: true,
        skip_actions: {}
      }
    };

    expect(() => validateTestAgainstProfile(testDef, baseProfile)).not.toThrow();
  });

  it('fails when an operation is missing', () => {
    const testDef: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'create item',
          tool: 'manage_items',
          arguments: { action: 'create' },
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: true,
        skip_actions: {}
      }
    };

    expect(() => validateTestAgainstProfile(testDef, baseProfile)).toThrowError(
      /Missing scenarios for: manage_items.delete/
    );
  });

  it('allows skips for resource-specific operations', () => {
    const profile: Profile = {
      profile_name: 'resources',
      tools: [
        {
          name: 'list_resources',
          description: 'List resources',
          operations: {
            list_project: 'listProject',
            list_group: 'listGroup'
          },
          parameters: {
            action: {
              type: 'string',
              required: true,
              enum: ['list'],
              description: 'Action to perform'
            },
            resource_type: {
              type: 'string',
              required: true,
              enum: ['project', 'group'],
              description: 'Resource discriminator'
            }
          }
        }
      ]
    };

    const testDef: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'list projects',
          tool: 'list_resources',
          arguments: { action: 'list', resource_type: 'project' },
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: true,
        skip_actions: {
          'list_resources.list_group': 'Not needed for this profile'
        }
      }
    };

    expect(() => validateTestAgainstProfile(testDef, profile)).not.toThrow();
  });
});
