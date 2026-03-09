import { describe, it, expect, afterEach } from 'vitest';
import { HeaderConfigParser } from './header-config-parser.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';
import { ValidationError, ConfigurationError } from '../../core/errors.js';

describe('HeaderConfigParser (X-Mcp4-Tools)', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);
  const parser = new HeaderConfigParser(compiler);

  it('parses empty header as empty request', () => {
    const req = parser.parse('');
    expect(req.hasRules).toBe(false);
    expect(req.exactNames.size).toBe(0);
    expect(req.regexPatterns).toHaveLength(0);
    expect(req.normalizedHeader).toBe('');
  });

  it('parses exact tool names and regex patterns', () => {
    const req = parser.parse('get_user, regex:get_.*');
    expect(req.hasRules).toBe(true);
    expect(req.exactNames.has('get_user')).toBe(true);
    expect(req.regexPatterns).toHaveLength(1);
  });

  it('accepts _allow_list and _allow_read keywords', () => {
    const req = parser.parse('_allow_list, _allow_read, get_user');
    expect(req.hasRules).toBe(true);
    expect(req.exactNames.has('get_user')).toBe(true);
    expect(req.allowCategories.has('list')).toBe(true);
    expect(req.allowCategories.has('read')).toBe(true);
  });

  it('accepts _allow_list only', () => {
    const req = parser.parse('_allow_list, get_user');
    expect(req.allowCategories.size).toBe(1);
    expect(req.allowCategories.has('list')).toBe(true);
  });

  it('accepts _allow_read only', () => {
    const req = parser.parse('_allow_read, get_user');
    expect(req.allowCategories.size).toBe(1);
    expect(req.allowCategories.has('read')).toBe(true);
  });

  it('rejects other _allow_* keywords with guidance to X-Mcp4-Params', () => {
    expect(() => parser.parse('_allow_write')).toThrow(ValidationError);
    expect(() => parser.parse('_allow_write')).toThrow(/Did you mean to use X-Mcp4-Params\?/);
  });

  it('combines categories with tool names and regex', () => {
    const req = parser.parse('get_user, _allow_list, regex:read_.*');
    expect(req.exactNames.has('get_user')).toBe(true);
    expect(req.allowCategories.has('list')).toBe(true);
    expect(req.regexPatterns).toHaveLength(1);
  });
});

describe('HeaderConfigParser - MCP4_TOOL_FILTER_SESSION_MAX_TOOLS', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);
  const parser = new HeaderConfigParser(compiler);
  
  let savedEnv: string | undefined;

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS = savedEnv;
    } else {
      delete process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS;
    }
  });

  it('throws on invalid env var value (non-numeric)', () => {
    savedEnv = process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS;
    process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS = 'invalid';
    
    expect(() => parser.parse('get_user')).toThrow(ConfigurationError);
    expect(() => parser.parse('get_user')).toThrow(/must be positive integer/);
    expect(() => parser.parse('get_user')).not.toThrow(/invalid/);
  });

  it('throws on negative value', () => {
    savedEnv = process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS;
    process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS = '-5';
    
    expect(() => parser.parse('get_user')).toThrow(ConfigurationError);
  });

  it('throws on zero value', () => {
    savedEnv = process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS;
    process.env.MCP4_TOOL_FILTER_SESSION_MAX_TOOLS = '0';
    
    expect(() => parser.parse('get_user')).toThrow(ConfigurationError);
  });
});
