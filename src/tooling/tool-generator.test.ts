/**
 * Tests for tool generator
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ToolGenerator } from './tool-generator.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { ProfileLoader } from '../profile/profile-loader.js';
import { ValidationError } from '../core/errors.js';
import type { Profile } from '../types/profile.js';
import path from 'path';

describe('ToolGenerator', () => {
  let generator: ToolGenerator;
  let parser: OpenAPIParser;
  let profile: Profile;

  beforeAll(async () => {
    parser = new OpenAPIParser();
    await parser.load(path.join(process.cwd(), 'profiles/gitlab/openapi.yaml'));
    
    generator = new ToolGenerator(parser);
    
    const loader = new ProfileLoader();
    profile = await loader.load(path.join(process.cwd(), 'profiles/gitlab/developer-profile-oauth.json'));
  });

  it('should generate MCP tool from profile definition', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    const tool = generator.generateTool(toolDef!);
    
    expect(tool.name).toBe('manage_project_badges');
    expect(tool.description).toBeDefined();
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.properties).toBeDefined();
  });

  it('should generate JSON schema with required fields', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    const tool = generator.generateTool(toolDef!);
    
    expect(tool.inputSchema.required).toContain('project_id');
    expect(tool.inputSchema.required).toContain('action');
  });

  it('should include enum values in schema', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    const tool = generator.generateTool(toolDef!);
    
    const actionProperty = tool.inputSchema.properties?.action as { enum?: string[] };
    expect(actionProperty?.enum).toContain('list');
    expect(actionProperty?.enum).toContain('create');
  });

  it('should default maxLength when pattern is set without maxLength', () => {
    const toolDef = {
      name: 'test_pattern_default_max',
      description: 'Test pattern default max length',
      parameters: {
        patternParam: {
          type: 'string' as const,
          description: 'Pattern param',
          pattern: '^[a-z]+$'
        }
      }
    };

    const tool = generator.generateTool(toolDef);
    const patternProperty = tool.inputSchema.properties?.patternParam as { maxLength?: number; pattern?: string };

    expect(patternProperty.pattern).toBe('^[a-z]+$');
    expect(patternProperty.maxLength).toBe(4096);
  });

  it('should not set maxLength when pattern and maxLength are missing', () => {
    const toolDef = {
      name: 'test_no_pattern_no_max',
      description: 'Test no pattern and no max length',
      parameters: {
        plainParam: {
          type: 'string' as const,
          description: 'Plain param'
        }
      }
    };

    const tool = generator.generateTool(toolDef);
    const plainProperty = tool.inputSchema.properties?.plainParam as { maxLength?: number };

    expect(plainProperty.maxLength).toBeUndefined();
  });

  it('should respect explicit maxLength without pattern', () => {
    const toolDef = {
      name: 'test_explicit_max_no_pattern',
      description: 'Test explicit max length without pattern',
      parameters: {
        maxOnly: {
          type: 'string' as const,
          description: 'Max only param',
          maxLength: 20
        }
      }
    };

    const tool = generator.generateTool(toolDef);
    const maxOnlyProperty = tool.inputSchema.properties?.maxOnly as { maxLength?: number };

    expect(maxOnlyProperty.maxLength).toBe(20);
  });

  it('should cap explicit maxLength to regex safety limit when pattern is present', () => {
    const toolDef = {
      name: 'test_explicit_max_with_pattern',
      description: 'Test explicit max length with pattern',
      parameters: {
        cappedParam: {
          type: 'string' as const,
          description: 'Capped param',
          pattern: '^[a-z]+$',
          maxLength: 10000
        }
      }
    };

    const tool = generator.generateTool(toolDef);
    const cappedProperty = tool.inputSchema.properties?.cappedParam as { maxLength?: number };

    expect(cappedProperty.maxLength).toBe(4096);
  });

  it('should validate required parameters', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    expect(() => {
      generator.validateArguments(toolDef!, { action: 'list' });
    }).toThrow(/project_id/);
  });

  it('should validate conditional requirements', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    expect(() => {
      generator.validateArguments(toolDef!, {
        project_id: '123',
        action: 'create'
      });
    }).toThrow(/link_url/);
  });

  it('should include action-gated hints in generated parameter description', () => {
    const toolDef = {
      name: 'test_action_hints',
      description: 'Action hint descriptions',
      operations: {
        update_alert: 'updateCodeScanningAlert',
        update_secret_scanning_alert: 'updateSecretScanningAlert'
      },
      parameters: {
        action: {
          type: 'string' as const,
          description: 'Action',
          enum: ['update_alert', 'update_secret_scanning_alert'],
          required: true
        },
        state: {
          type: 'string' as const,
          description: 'State',
          required_for: ['update_alert'],
          allowed_for: ['update_alert', 'update_secret_scanning_alert'],
          forbidden_for: ['update_secret_scanning_alert'],
          enum_for: {
            update_alert: ['open', 'dismissed'],
            update_secret_scanning_alert: ['open', 'resolved']
          }
        }
      }
    };

    const tool = generator.generateTool(toolDef);
    const stateProperty = tool.inputSchema.properties?.state as { description?: string };

    expect(stateProperty.description).toContain('Required when action is: update_alert.');
    expect(stateProperty.description).toContain('Allowed only when action is: update_alert, update_secret_scanning_alert.');
    expect(stateProperty.description).toContain('Not allowed when action is: update_secret_scanning_alert.');
    expect(stateProperty.description).toContain('Allowed values by action: update_alert=[open, dismissed]; update_secret_scanning_alert=[open, resolved].');
  });

  it('should reject parameters outside allowed_for actions', () => {
    const toolDef = {
      name: 'test_allowed_for',
      description: 'Allowed-for validation',
      operations: {
        list: 'getSomething',
        get: 'getSomethingElse'
      },
      parameters: {
        action: {
          type: 'string' as const,
          description: 'Action',
          enum: ['list', 'get'],
          required: true
        },
        detail_level: {
          type: 'string' as const,
          description: 'Detail level',
          allowed_for: ['get']
        }
      }
    };

    expect(() => {
      generator.validateArguments(toolDef, { action: 'list', detail_level: 'full' });
    }).toThrow(/not allowed for action 'list'/);

    expect(() => {
      generator.validateArguments(toolDef, { action: 'get', detail_level: 'full' });
    }).not.toThrow();
  });

  it('should reject parameters for forbidden_for actions', () => {
    const toolDef = {
      name: 'test_forbidden_for',
      description: 'Forbidden-for validation',
      operations: {
        update_alert: 'updateCodeScanningAlert',
        update_secret_scanning_alert: 'updateSecretScanningAlert'
      },
      parameters: {
        action: {
          type: 'string' as const,
          description: 'Action',
          enum: ['update_alert', 'update_secret_scanning_alert'],
          required: true
        },
        dismissed_reason: {
          type: 'string' as const,
          description: 'Dismiss reason',
          forbidden_for: ['update_secret_scanning_alert']
        }
      }
    };

    expect(() => {
      generator.validateArguments(toolDef, {
        action: 'update_secret_scanning_alert',
        dismissed_reason: 'false positive'
      });
    }).toThrow(/not allowed for action 'update_secret_scanning_alert'/);

    expect(() => {
      generator.validateArguments(toolDef, {
        action: 'update_alert',
        dismissed_reason: 'false positive'
      });
    }).not.toThrow();
  });

  it('should validate enum_for values per action', () => {
    const toolDef = {
      name: 'test_enum_for',
      description: 'Action-scoped enum validation',
      operations: {
        list_alerts: 'listCodeScanningAlerts',
        list_secret_scanning_alerts: 'listSecretScanningAlerts'
      },
      parameters: {
        action: {
          type: 'string' as const,
          description: 'Action',
          enum: ['list_alerts', 'list_secret_scanning_alerts'],
          required: true
        },
        state: {
          type: 'string' as const,
          description: 'State',
          enum: ['open', 'closed', 'resolved'],
          allowed_for: ['list_alerts', 'list_secret_scanning_alerts'],
          enum_for: {
            list_alerts: ['open', 'closed'],
            list_secret_scanning_alerts: ['open', 'resolved']
          }
        }
      }
    };

    expect(() => {
      generator.validateArguments(toolDef, { action: 'list_alerts', state: 'resolved' });
    }).toThrow(/Invalid value for state when action is 'list_alerts'/);

    expect(() => {
      generator.validateArguments(toolDef, { action: 'list_secret_scanning_alerts', state: 'resolved' });
    }).not.toThrow();
  });

  it('should map action to operation ID', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    const listOp = generator.mapActionToOperation(toolDef!, {
      action: 'list'
    });
    expect(listOp).toBe('getApiV4ProjectsIdBadges');
    
    const createOp = generator.mapActionToOperation(toolDef!, {
      action: 'create'
    });
    expect(createOp).toBe('postApiV4ProjectsIdBadges');
  });

  it('should map repository commits action to operation ID', () => {
    const toolDef = profile.tools.find(t => t.name === 'repository_commits');
    expect(toolDef).toBeDefined();

    const listOp = generator.mapActionToOperation(toolDef!, {
      action: 'list'
    });
    expect(listOp).toBe('getApiV4ProjectsIdRepositoryCommits');
  });

  it('should handle resource_type discrimination', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_access_requests');
    expect(toolDef).toBeDefined();
    
    const projectOp = generator.mapActionToOperation(toolDef!, {
      action: 'list',
      resource_type: 'project'
    });
    expect(projectOp).toBe('getApiV4ProjectsIdAccessRequests');
    
    const groupOp = generator.mapActionToOperation(toolDef!, {
      action: 'list',
      resource_type: 'group'
    });
    expect(groupOp).toBe('getApiV4GroupsIdAccessRequests');
  });

  it('should reject invalid enum value', () => {
    const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
    expect(toolDef).toBeDefined();
    
    expect(() => {
      generator.validateArguments(toolDef!, {
        project_id: '123',
        action: 'invalid_action'
      });
    }).toThrow(/Invalid value for action/);
  });

  it('should generate valid JSON Schema for array parameters with items', () => {
    // Create minimal tool definition with array parameter
    const toolDef = {
      name: 'test_array',
      description: 'Test array parameter',
      parameters: {
        tags: {
          type: 'array' as const,
          description: 'List of tags',
          items: { type: 'string' }
        }
      }
    };
    
    const tool = generator.generateTool(toolDef);
    const tagsProperty = tool.inputSchema.properties?.tags as { type: string; items?: unknown };
    
    expect(tagsProperty.type).toBe('array');
    expect(tagsProperty.items).toBeDefined();
    expect(tagsProperty.items).toEqual({ type: 'string' });
  });

  it('should generate valid JSON Schema for object parameters with properties', () => {
    // Create minimal tool definition with object parameter
    const toolDef = {
      name: 'test_object',
      description: 'Test object parameter',
      parameters: {
        config: {
          type: 'object' as const,
          description: 'Configuration object',
          properties: {}
        }
      }
    };
    
    const tool = generator.generateTool(toolDef);
    const configProperty = tool.inputSchema.properties?.config as { type: string; properties?: unknown };
    
    expect(configProperty.type).toBe('object');
    expect(configProperty.properties).toBeDefined();
    expect(configProperty.properties).toEqual({});
  });

  it('should generate oneOf schema for multi-type parameters', () => {
    const toolDef = {
      name: 'test_multi_type',
      description: 'Test multi type parameter',
      parameters: {
        customFields: {
          type: ['object', 'array'] as ('object' | 'array')[],
          description: 'Custom fields',
          properties: {},
          items: { type: 'object' }
        }
      }
    };

    const tool = generator.generateTool(toolDef);
    const customFieldsProperty = tool.inputSchema.properties?.customFields as { oneOf?: unknown[] };

    expect(customFieldsProperty.oneOf).toBeDefined();
    expect(customFieldsProperty.oneOf).toHaveLength(2);
    expect(customFieldsProperty.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'object' }),
        expect.objectContaining({ type: 'array', items: { type: 'object' } })
      ])
    );
  });

  it('should fail validation if array parameter is missing items', () => {
    // This test documents the bug that was fixed
    const toolDefInvalid = {
      name: 'test_invalid_array',
      description: 'Test invalid array',
      parameters: {
        tags: {
          type: 'array' as const,
          description: 'List of tags'
          // Missing items property
        }
      }
    };
    
    const tool = generator.generateTool(toolDefInvalid);
    const tagsProperty = tool.inputSchema.properties?.tags as { type: string; items?: unknown };
    
    // After fix, items should be undefined when not provided in profile
    // MCP SDK will reject this, so we should catch it in validation
    expect(tagsProperty.items).toBeUndefined();
  });

  describe('buildFormDataBody', () => {
    it('should build FormData from base64 content with provided values', () => {
      // Use actual base64 encoding to ensure non-empty string
      const textContent = 'test file content';
      const base64Content = btoa(textContent);
      expect(base64Content).toBeTruthy(); // Ensure base64Content is not empty
      
      const args = {
        base64Content,
        fileName: 'test.txt',
        mimeType: 'text/plain'
      };

      const formData = generator.buildFormDataBody(args);
      expect(formData).toBeInstanceOf(FormData);
      
      // Verify append was called by checking FormData entries
      const entries = Array.from(formData.entries());
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0][0]).toBe('files[0]');
    });

    it('should use default fileName when not provided', () => {
      const textContent = 'test content';
      const base64Content = btoa(textContent);
      const args = { base64Content };

      const formData = generator.buildFormDataBody(args);
      expect(formData).toBeInstanceOf(FormData);
      
      const entries = Array.from(formData.entries());
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should use default mimeType when not provided', () => {
      const textContent = 'binary data';
      const base64Content = btoa(textContent);
      const args = {
        base64Content,
        fileName: 'data.bin'
      };

      const formData = generator.buildFormDataBody(args);
      expect(formData).toBeInstanceOf(FormData);
      
      const entries = Array.from(formData.entries());
      expect(entries.length).toBeGreaterThan(0);
    });

    it('should use custom fieldName parameter', () => {
      const textContent = 'file content';
      const base64Content = btoa(textContent);
      const args = {
        base64Content,
        fileName: 'upload.pdf'
      };

      const formData = generator.buildFormDataBody(args, 'document');
      expect(formData).toBeInstanceOf(FormData);
      
      const entries = Array.from(formData.entries());
      expect(entries[0][0]).toBe('document');
    });

    it('should handle empty base64Content gracefully', () => {
      const args = { base64Content: '' };
      const formData = generator.buildFormDataBody(args);
      expect(formData).toBeInstanceOf(FormData);
      
      // Empty base64Content should result in empty FormData
      const entries = Array.from(formData.entries());
      expect(entries.length).toBe(0);
    });

    it('should handle missing base64Content', () => {
      const args = { fileName: 'test.txt' };
      const formData = generator.buildFormDataBody(args);
      expect(formData).toBeInstanceOf(FormData);
      
      // No base64Content means FormData stays empty
      const entries = Array.from(formData.entries());
      expect(entries.length).toBe(0);
    });

    it('should throw ValidationError for invalid base64 content', () => {
      const args = { base64Content: 'invalid-base64!' };
      expect(() => {
        generator.buildFormDataBody(args);
      }).toThrow(ValidationError);
    });

    it('should build FormData with binary content (non-ASCII)', () => {
      // Create base64 content with binary data (e.g., image data)
      const binaryData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
      let binary = '';
      for (let i = 0; i < binaryData.length; i++) {
        binary += String.fromCharCode(binaryData[i]);
      }
      const base64Content = btoa(binary);
      
      const args = {
        base64Content,
        fileName: 'image.jpg',
        mimeType: 'image/jpeg'
      };

      const formData = generator.buildFormDataBody(args);
      expect(formData).toBeInstanceOf(FormData);
      
      const entries = Array.from(formData.entries());
      expect(entries.length).toBeGreaterThan(0);
      const [fieldName, file] = entries[0];
      expect(fieldName).toBe('files[0]');
      if (file instanceof File) {
        expect(file.type).toBe('image/jpeg');
        expect(file.name).toBe('image.jpg');
      }
    });

    it('should handle multipart operation detection', () => {
      const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
      expect(toolDef).toBeDefined();

      const mapOp = generator.mapActionToOperation(toolDef!, {
        action: 'list'
      });
      
      const isMultipart = generator.isMultipartOperation(mapOp!);
      expect(typeof isMultipart).toBe('boolean');
    });

    it('should return false for non-multipart operations', () => {
      const toolDef = profile.tools.find(t => t.name === 'manage_project_badges');
      expect(toolDef).toBeDefined();

      const mapOp = generator.mapActionToOperation(toolDef!, {
        action: 'list'
      });

      const isMultipart = generator.isMultipartOperation(mapOp!);
      expect(isMultipart).toBe(false);
    });

    it('should return true for multipart operations', () => {
      const stubParser: any = {
        getOperation: () => ({
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: { type: 'object' }
              }
            }
          }
        })
      };

      const multipartGenerator = new ToolGenerator(stubParser);
      expect(multipartGenerator.isMultipartOperation('uploadOp')).toBe(true);
    });
  });
});
