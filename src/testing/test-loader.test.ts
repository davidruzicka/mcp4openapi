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
        skip_actions: {},
        require_request_assertions: false,
        skip_request_assertions: {}
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
        skip_actions: {},
        require_request_assertions: false,
        skip_request_assertions: {}
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
        },
        require_request_assertions: false,
        skip_request_assertions: {}
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
        skip_actions: {},
        require_request_assertions: false,
        skip_request_assertions: {}
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
        skip_actions: {},
        require_request_assertions: false,
        skip_request_assertions: {}
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

  it('enforces destructive action coverage unless explicitly skipped', () => {
    const profile: Profile = {
      profile_name: 'dangerous',
      tools: [
        {
          name: 'manage_jobs',
          description: 'Manage jobs',
          operations: {
            create: 'createJob',
            cancel: 'cancelJob',
            reset: 'resetJob'
          },
          parameters: {
            action: {
              type: 'string',
              required: true,
              enum: ['create', 'cancel', 'reset'],
              description: 'Action to perform'
            }
          }
        }
      ]
    };

    const missingDestructive: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'create job',
          tool: 'manage_jobs',
          arguments: { action: 'create' },
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: false,
        skip_actions: {},
        require_request_assertions: false,
        skip_request_assertions: {}
      }
    };

    expect(() => validateTestAgainstProfile(missingDestructive, profile)).toThrowError(
      /Destructive actions missing coverage: manage_jobs.cancel, manage_jobs.reset/
    );

    const skippedDestructive: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'create job',
          tool: 'manage_jobs',
          arguments: { action: 'create' },
          expect: { success: true }
        }
      ],
      coverage: {
        require_all_actions: false,
        skip_actions: {
          'manage_jobs.cancel': 'Cancel covered elsewhere',
          reset: 'Reset not supported in staging'
        },
        require_request_assertions: false,
        skip_request_assertions: {}
      }
    };

    expect(() => validateTestAgainstProfile(skippedDestructive, profile)).not.toThrow();
  });

  it('fails when a moved action is referenced through the wrong tool', () => {
    const profile: Profile = {
      profile_name: 'grafana-split',
      tools: [
        {
          name: 'retrieve_content',
          description: 'Content reads only',
          operations: {
            search: 'search'
          },
          parameters: {
            action: {
              type: 'string',
              required: true,
              enum: ['search'],
              description: 'Action to perform'
            },
            query: {
              type: 'string',
              description: 'Search query'
            }
          }
        },
        {
          name: 'retrieve_admin_content',
          description: 'Admin reads only',
          operations: {
            get_user_by_login_or_email: 'getUserByLoginOrEmail'
          },
          parameters: {
            action: {
              type: 'string',
              required: true,
              enum: ['get_user_by_login_or_email'],
              description: 'Action to perform'
            },
            loginOrEmail: {
              type: 'string',
              description: 'Login or email',
              required_for: ['get_user_by_login_or_email']
            }
          }
        }
      ]
    };

    const testDef: ProfileTestDefinition = {
      scenarios: [
        {
          name: 'wrong tool for moved admin action',
          tool: 'retrieve_content',
          arguments: {
            action: 'get_user_by_login_or_email',
            loginOrEmail: 'admin@example.com'
          },
          expect: { success: false }
        }
      ],
      coverage: {
        require_all_actions: false,
        skip_actions: {
          'retrieve_content.search': 'Not relevant for this boundary check',
          'retrieve_admin_content.get_user_by_login_or_email': 'Boundary check only'
        },
        require_request_assertions: false,
        skip_request_assertions: {}
      }
    };

    expect(() => validateTestAgainstProfile(testDef, profile)).toThrowError(
      /does not map to a known operation for tool 'retrieve_content'/
    );
  });
});
