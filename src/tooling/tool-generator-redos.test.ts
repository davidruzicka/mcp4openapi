
import { describe, it, expect } from 'vitest';
import { ToolGenerator } from './tool-generator.js';
import { OpenAPIParser } from '../openapi/openapi-parser.js';

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

  it('should reject unsafe regex patterns (ambiguous alternation)', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'test_redos_ambiguous_alternation',
      description: 'Test ReDoS ambiguous alternation',
      parameters: {
        unsafeParam: {
          type: 'string' as const,
          description: 'Unsafe param',
          pattern: '^(a|a)+$', // Ambiguous alternation
          required: true
        }
      }
    };

    const shortString = 'aaa';

    expect(() => {
      generator.validateArguments(toolDef as any, { unsafeParam: shortString });
    }).toThrow(/Unsafe regex/);
  });

  it('should reject regex patterns exceeding length limit (1024)', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const longPattern = '^' + 'a'.repeat(1030) + '$';

    const toolDef = {
      name: 'test_redos_long_pattern',
      description: 'Test ReDoS long pattern',
      parameters: {
        longPatternParam: {
          type: 'string' as const,
          description: 'Long pattern param',
          pattern: longPattern,
          required: true
        }
      }
    };

    const shortString = 'a';

    expect(() => {
      generator.validateArguments(toolDef as any, { longPatternParam: shortString });
    }).toThrow(/Unsafe regex: Pattern exceeds/);
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

  it('should handle invalid regex syntax gracefully', () => {
    const parser = new OpenAPIParser();
    const generator = new ToolGenerator(parser);

    const toolDef = {
      name: 'test_invalid_syntax',
      description: 'Test invalid syntax',
      parameters: {
        invalidParam: {
          type: 'string' as const,
          description: 'Invalid param',
          pattern: '[', // Invalid regex syntax (unclosed bracket)
          required: true
        }
      }
    };

    const shortString = 'a';

    // Should catch SyntaxError from new RegExp() and rethrow as ValidationError
    expect(() => {
      generator.validateArguments(toolDef as any, { invalidParam: shortString });
    }).toThrow(/Invalid pattern/);
  });
});
