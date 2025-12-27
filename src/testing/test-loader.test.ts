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

  it('requires coverage for composite tools', () => {
    const profile: Profile = {
      profile_name: 'composite',
      tools: [
        {
          name: 'aggregate_items',
          description: 'Aggregate items',
          composite: true,
          steps: [],
          parameters: {}
        }
      ]
    };

    const incompleteDef: ProfileTestDefinition = {
      scenarios: [],
      coverage: {
        require_all_actions: true,
        skip_actions: {}
      }
    };

    expect(() => validateTestAgainstProfile(incompleteDef, profile)).toThrowError(
      /Missing scenarios for: aggregate_items/
    );

    const testDef: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'aggregate items',
          tool: 'aggregate_items',
          arguments: {},
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: true,
        skip_actions: {}
      }
    };

    expect(() => validateTestAgainstProfile(testDef, profile)).not.toThrow();
  });

  it('fails when critical scenarios lack request assertions', () => {
    const profile: Profile = {
      profile_name: 'requests',
      parameter_aliases: {
        project_id: ['project']
      },
      tools: [
        {
          name: 'manage_items',
          description: 'Manage items',
          operations: {
            list: 'listItems',
            download: {
              type: 'proxy_download',
              metadata_endpoint: 'getItemDownload'
            }
          },
          parameters: {
            action: {
              type: 'string',
              required: true,
              enum: ['list', 'download'],
              description: 'Action to perform'
            },
            project: {
              type: 'string',
              description: 'Project alias'
            },
            trace: {
              type: 'string',
              description: 'Trace flag'
            }
          },
          response_fields: {
            list: ['id']
          },
          send_response_fields_as_param: true,
          metadata_params: ['action', 'trace']
        }
      ]
    };

    const testDef: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'list items',
          tool: 'manage_items',
          arguments: { action: 'list', project: 'demo', trace: '1' },
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: false,
        skip_actions: {},
        require_request_assertions: true,
        skip_request_assertions: {}
      }
    };

    expect(() => validateTestAgainstProfile(testDef, profile)).toThrowError(
      /must include request assertions/
    );
  });

  it('allows skips and passes when request assertions are present', () => {
    const profile: Profile = {
      profile_name: 'requests',
      tools: [
        {
          name: 'download_items',
          description: 'Download items',
          operations: {
            download: {
              type: 'proxy_download',
              metadata_endpoint: 'getItemDownload'
            }
          },
          parameters: {
            action: {
              type: 'string',
              required: true,
              enum: ['download'],
              description: 'Action to perform'
            }
          }
        }
      ]
    };

    const skippedDef: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'download items',
          tool: 'download_items',
          arguments: { action: 'download' },
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: false,
        skip_actions: {},
        require_request_assertions: true,
        skip_request_assertions: {
          'download items': 'Request assertions covered elsewhere'
        }
      }
    };

    expect(() => validateTestAgainstProfile(skippedDef, profile)).not.toThrow();

    const withAssertions: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'download items with request',
          tool: 'download_items',
          arguments: { action: 'download' },
          expect: {
            success: true,
            request: { method: 'GET', path: '/downloads/1' }
          }
        }
      ],
      coverage: {
        require_all_actions: false,
        skip_actions: {},
        require_request_assertions: true,
        skip_request_assertions: {}
      }
    };

    expect(() => validateTestAgainstProfile(withAssertions, profile)).not.toThrow();
  });
});
