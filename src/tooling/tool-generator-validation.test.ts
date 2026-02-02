
import { describe, it, expect } from 'vitest';
import { ToolGenerator } from './tool-generator.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import type { ToolDefinition } from '../types/profile.js';
import { ValidationError } from '../core/errors.js';

describe('ToolGenerator Validation', () => {
  const parser = {} as OpenAPIParser;
  const generator = new ToolGenerator(parser);

  it('validates minLength', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        shortParam: {
          type: 'string',
          description: 'Short param',
          minLength: 5,
        },
      },
    };

    expect(() => generator.validateArguments(toolDef, { shortParam: 'abc' })).toThrow(
      'Invalid value for shortParam. Length must be at least 5'
    );
    expect(() => generator.validateArguments(toolDef, { shortParam: 'abc' })).toThrow(ValidationError);
    expect(() => generator.validateArguments(toolDef, { shortParam: 'abcde' })).not.toThrow();
  });

  it('validates maxLength', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        longParam: {
          type: 'string',
          description: 'Long param',
          maxLength: 5,
        },
      },
    };

    expect(() => generator.validateArguments(toolDef, { longParam: 'abcdef' })).toThrow(
      'Invalid value for longParam. Length must be at most 5'
    );
    expect(() => generator.validateArguments(toolDef, { longParam: 'abcdef' })).toThrow(ValidationError);
    expect(() => generator.validateArguments(toolDef, { longParam: 'abcde' })).not.toThrow();
  });

  it('validates pattern', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        patternParam: {
          type: 'string',
          description: 'Pattern param',
          pattern: '^[a-z]+$',
        },
      },
    };

    expect(() => generator.validateArguments(toolDef, { patternParam: '123' })).toThrow(
      'Invalid value for patternParam. Must match pattern: ^[a-z]+$'
    );
    expect(() => generator.validateArguments(toolDef, { patternParam: '123' })).toThrow(ValidationError);
    expect(() => generator.validateArguments(toolDef, { patternParam: 'abc' })).not.toThrow();
  });

  it('rejects invalid regex patterns', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        badPattern: {
          type: 'string',
          description: 'Bad pattern',
          pattern: '[',
        },
      },
    };

    expect(() => generator.validateArguments(toolDef, { badPattern: 'abc' })).toThrow(ValidationError);
    expect(() => generator.validateArguments(toolDef, { badPattern: 'abc' })).toThrow(
      'Invalid pattern for badPattern.'
    );
  });

  it('generates correct JSON schema', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        constrainedParam: {
          type: 'string',
          description: 'Constrained param',
          minLength: 2,
          maxLength: 10,
          pattern: '^[a-z]+$',
        },
      },
    };

    const tool = generator.generateTool(toolDef);
    const props = tool.inputSchema.properties as any;

    expect(props.constrainedParam).toMatchObject({
      type: 'string',
      description: 'Constrained param',
      minLength: 2,
      maxLength: 10,
      pattern: '^[a-z]+$',
    });
  });
});
