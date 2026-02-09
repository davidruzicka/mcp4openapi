
import { describe, it, expect } from 'vitest';
import { ToolGenerator } from './tool-generator.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import type { ToolDefinition } from '../types/profile.js';
import { ValidationError } from '../core/errors.js';

describe('ToolGenerator ReDoS Protection', () => {
  const parser = {} as OpenAPIParser;
  const generator = new ToolGenerator(parser);

  it('blocks long input when maxLength is NOT set', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        patternParam: {
          type: 'string',
          description: 'Pattern param',
          pattern: '^[a-z]+$',
          // No maxLength
        },
      },
    };

    // Create a long string (5000 chars > 4096)
    const longString = 'a'.repeat(5000);

    // Should now throw ValidationError due to security check
    expect(() => generator.validateArguments(toolDef, { patternParam: longString })).toThrowError(ValidationError);
    expect(() => generator.validateArguments(toolDef, { patternParam: longString })).toThrow(
      'Value too long for pattern matching (max 4096 chars)'
    );
  });

  it('allows safe length input when maxLength is NOT set', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        patternParam: {
          type: 'string',
          description: 'Pattern param',
          pattern: '^[a-z]+$',
          // No maxLength
        },
      },
    };

    // Create a safe length string (4000 chars < 4096)
    const safeString = 'a'.repeat(4000);

    expect(() => generator.validateArguments(toolDef, { patternParam: safeString })).not.toThrow();
  });

  it('enforces regex safety cap even if maxLength is set larger than default', () => {
    const toolDef: ToolDefinition = {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        explicitParam: {
          type: 'string',
          description: 'Explicit large param',
          pattern: '^[a-z]+$',
          maxLength: 10000, // Explicitly allowed larger
        },
      },
    };

    const largeString = 'a'.repeat(5000);

    // Should NOW throw because we enforce safe cap for regex validation
    expect(() => generator.validateArguments(toolDef, { explicitParam: largeString })).toThrow(
      'Value too long for pattern matching (max 4096 chars)'
    );

    // But if it exceeds explicit maxLength, it should throw standard error (caught earlier)
    const tooLargeString = 'a'.repeat(10001);
    expect(() => generator.validateArguments(toolDef, { explicitParam: tooLargeString })).toThrow(
      'Length must be at most 10000'
    );
  });
});
