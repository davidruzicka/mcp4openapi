import { describe, it, expect } from 'vitest';
import { HeaderConfigParser } from './header-config-parser.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';
import { ValidationError } from '../errors.js';

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
});

