import { describe, it, expect } from 'vitest';
import { EnvConfigParser } from './env-config-parser.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';
import { ConfigurationError } from '../errors.js';

describe('EnvConfigParser', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);
  const parser = new EnvConfigParser(compiler);

  describe('empty configuration', () => {
    it('returns undefined when no env vars set', () => {
      const config = parser.parse({});
      expect(config).toBeUndefined();
    });

    it('returns undefined when all env vars empty', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: '',
        MCP4_TOOL_FILTER_ALLOW_NAME_REGEX: '',
        MCP4_TOOL_FILTER_DENY_NAMES: '',
        MCP4_TOOL_FILTER_DENY_NAME_REGEX: '',
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: ''
      });
      expect(config).toBeUndefined();
    });
  });

  describe('allow list parsing', () => {
    it('parses single tool name', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'get_user'
      });
      
      expect(config).toBeDefined();
      expect(config!.allowList.has('get_user')).toBe(true);
      expect(config!.hasAllowRules).toBe(true);
    });

    it('parses multiple tool names', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'get_user,list_users,read_project'
      });
      
      expect(config!.allowList.size).toBe(3);
      expect(config!.allowList.has('get_user')).toBe(true);
      expect(config!.allowList.has('list_users')).toBe(true);
      expect(config!.allowList.has('read_project')).toBe(true);
    });

    it('trims whitespace from names', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: '  get_user  ,  list_users  '
      });
      
      expect(config!.allowList.has('get_user')).toBe(true);
      expect(config!.allowList.has('list_users')).toBe(true);
    });

    it('normalizes tool names with Unicode NFC', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'café'
      });
      
      expect(config!.allowList.has('café')).toBe(true);
    });

    it('filters empty entries', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'get_user,,list_users,'
      });
      
      expect(config!.allowList.size).toBe(2);
    });
  });

  describe('deny list parsing', () => {
    it('parses deny list', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_DENY_NAMES: 'delete_user,drop_table'
      });
      
      expect(config!.denyList.size).toBe(2);
      expect(config!.denyList.has('delete_user')).toBe(true);
      expect(config!.denyList.has('drop_table')).toBe(true);
    });
  });

  describe('regex parsing', () => {
    it('parses allow regex patterns', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAME_REGEX: 'get_.*,read_.*'
      });
      
      expect(config!.allowRegex.length).toBe(2);
      expect(config!.allowRegex[0].test('get_user')).toBe(true);
      expect(config!.allowRegex[1].test('read_item')).toBe(true);
    });

    it('parses deny regex patterns', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_DENY_NAME_REGEX: 'delete_.*'
      });
      
      expect(config!.denyRegex.length).toBe(1);
      expect(config!.denyRegex[0].test('delete_user')).toBe(true);
    });

    it('auto-anchors regex patterns', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAME_REGEX: 'user'
      });
      
      expect(config!.allowRegex[0].test('user')).toBe(true);
      expect(config!.allowRegex[0].test('get_user')).toBe(false);
    });

    it('throws on invalid regex', () => {
      expect(() => parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAME_REGEX: '(unclosed'
      })).toThrow(ConfigurationError);
    });

    it('throws on ReDoS vulnerable regex', () => {
      expect(() => parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAME_REGEX: '(a+)+'
      })).toThrow(ConfigurationError);
    });
  });

  describe('category parsing', () => {
    it('parses list category', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'list'
      });
      
      expect(config!.allowCategories.has('list')).toBe(true);
      expect(config!.hasAllowRules).toBe(true);
    });

    it('parses read category', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'read'
      });
      
      expect(config!.allowCategories.has('read')).toBe(true);
    });

    it('parses both categories', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'list,read'
      });
      
      expect(config!.allowCategories.size).toBe(2);
      expect(config!.allowCategories.has('list')).toBe(true);
      expect(config!.allowCategories.has('read')).toBe(true);
    });

    it('normalizes category names (case-insensitive)', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'LIST,Read'
      });
      
      expect(config!.allowCategories.has('list')).toBe(true);
      expect(config!.allowCategories.has('read')).toBe(true);
    });

    it('throws on invalid category', () => {
      expect(() => parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'invalid'
      })).toThrow(ConfigurationError);
      
      expect(() => parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'list,modify'
      })).toThrow(ConfigurationError);
    });

    it('filters empty entries', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'list,,read,'
      });
      
      expect(config!.allowCategories.size).toBe(2);
    });
  });

  describe('hasAllowRules flag', () => {
    it('sets true when allow list present', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'tool'
      });
      expect(config!.hasAllowRules).toBe(true);
    });

    it('sets true when allow regex present', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAME_REGEX: 'get_.*'
      });
      expect(config!.hasAllowRules).toBe(true);
    });

    it('sets true when allow categories present', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'list'
      });
      expect(config!.hasAllowRules).toBe(true);
    });

    it('sets false when only deny rules present', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_DENY_NAMES: 'delete_user'
      });
      expect(config!.hasAllowRules).toBe(false);
    });
  });

  describe('sources tracking', () => {
    it('preserves source values', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'get_user,list_users',
        MCP4_TOOL_FILTER_DENY_NAMES: 'delete_user'
      });
      
      expect(config!.sources.allowList).toEqual(['get_user', 'list_users']);
      expect(config!.sources.denyList).toEqual(['delete_user']);
    });
  });

  describe('combined configuration', () => {
    it('parses all fields together', () => {
      const config = parser.parse({
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'get_user',
        MCP4_TOOL_FILTER_ALLOW_NAME_REGEX: 'read_.*',
        MCP4_TOOL_FILTER_DENY_NAMES: 'delete_user',
        MCP4_TOOL_FILTER_DENY_NAME_REGEX: 'drop_.*',
        MCP4_TOOL_FILTER_ALLOW_CATEGORIES: 'list,read'
      });
      
      expect(config!.allowList.size).toBe(1);
      expect(config!.allowRegex.length).toBe(1);
      expect(config!.denyList.size).toBe(1);
      expect(config!.denyRegex.length).toBe(1);
      expect(config!.allowCategories.size).toBe(2);
      expect(config!.hasAllowRules).toBe(true);
    });
  });
});
