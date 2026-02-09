
import { describe, it, expect } from 'vitest';
import { ToolGenerator } from './tool-generator.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';
import { ValidationError } from '../core/errors.js';

describe('ToolGenerator ReDoS Protection', () => {
  it('should reject inputs > 4096 chars when pattern is present, even if maxLength is larger', () => {
    // Mock parser
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'test_redos_risk_length',
      description: 'Test ReDoS risk length',
      parameters: {
        riskyParam: {
          type: 'string' as const,
          description: 'Risky param',
          pattern: '^.*$', // Simple pattern
          maxLength: 100000, // Explicitly allow long strings
          required: true
        }
      }
    };

    const longString = 'a'.repeat(5000); // > 4096

    expect(() => {
      generator.validateArguments(toolDef as any, { riskyParam: longString });
    }).toThrow(/Value too long for pattern matching/);
  });

  it('should reject unsafe regex patterns (nested quantifiers)', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'test_redos_unsafe_pattern',
      description: 'Test ReDoS unsafe pattern',
      parameters: {
        unsafeParam: {
          type: 'string' as const,
          description: 'Unsafe param',
          pattern: '^(a+)+$', // Evil regex
          required: true
        }
      }
    };

    const shortString = 'aaa';

    expect(() => {
      generator.validateArguments(toolDef as any, { unsafeParam: shortString });
    }).toThrow(/Unsafe regex/);
  });

  it('should allow safe patterns with short inputs', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'test_safe_pattern',
      description: 'Test safe pattern',
      parameters: {
        safeParam: {
          type: 'string' as const,
          description: 'Safe param',
          pattern: '^[a-z]+$',
          required: true
        }
      }
    };

    const safeString = 'abc';

    expect(() => {
      generator.validateArguments(toolDef as any, { safeParam: safeString });
    }).not.toThrow();
  });
});
