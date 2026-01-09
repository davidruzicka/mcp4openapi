import { describe, it, expect } from 'vitest';
import { ExactMatchRule, RegexMatchRule } from './filter-rules.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';

describe('ExactMatchRule', () => {
  describe('allow rules', () => {
    it('matches tool names in allow set', () => {
      const rule = new ExactMatchRule(new Set(['get_user', 'list_users']), 'allow');
      
      expect(rule.matches('get_user')).toBe(true);
      expect(rule.matches('list_users')).toBe(true);
      expect(rule.matches('delete_user')).toBe(false);
    });

    it('is case-sensitive', () => {
      const rule = new ExactMatchRule(new Set(['GetUser']), 'allow');
      
      expect(rule.matches('GetUser')).toBe(true);
      expect(rule.matches('getuser')).toBe(false);
      expect(rule.matches('GETUSER')).toBe(false);
    });

    it('returns correct reason for allow', () => {
      const rule = new ExactMatchRule(new Set(['test']), 'allow');
      expect(rule.getReason()).toBe('allow_list');
    });
  });

  describe('deny rules', () => {
    it('matches tool names in deny set', () => {
      const rule = new ExactMatchRule(new Set(['delete_user', 'drop_table']), 'deny');
      
      expect(rule.matches('delete_user')).toBe(true);
      expect(rule.matches('drop_table')).toBe(true);
      expect(rule.matches('get_user')).toBe(false);
    });

    it('returns correct reason for deny', () => {
      const rule = new ExactMatchRule(new Set(['test']), 'deny');
      expect(rule.getReason()).toBe('deny_list');
    });
  });

  describe('empty sets', () => {
    it('never matches when set is empty', () => {
      const rule = new ExactMatchRule(new Set(), 'allow');
      expect(rule.matches('anything')).toBe(false);
    });
  });
});

describe('RegexMatchRule', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);

  describe('allow rules', () => {
    it('matches tool names against patterns', () => {
      const patterns = [
        compiler.compile('get_.*', 'test'),
        compiler.compile('read_.*', 'test')
      ];
      const rule = new RegexMatchRule(patterns, 'allow');
      
      expect(rule.matches('get_user')).toBe(true);
      expect(rule.matches('get_project')).toBe(true);
      expect(rule.matches('read_item')).toBe(true);
      expect(rule.matches('delete_user')).toBe(false);
    });

    it('matches with anchored patterns', () => {
      const patterns = [compiler.compile('user', 'test')];
      const rule = new RegexMatchRule(patterns, 'allow');
      
      expect(rule.matches('user')).toBe(true);
      expect(rule.matches('get_user')).toBe(false);
      expect(rule.matches('user_admin')).toBe(false);
    });

    it('returns correct reason for allow', () => {
      const patterns = [compiler.compile('test', 'test')];
      const rule = new RegexMatchRule(patterns, 'allow');
      expect(rule.getReason()).toBe('allow_regex');
    });
  });

  describe('deny rules', () => {
    it('matches tool names to deny', () => {
      const patterns = [compiler.compile('delete_.*', 'test')];
      const rule = new RegexMatchRule(patterns, 'deny');
      
      expect(rule.matches('delete_user')).toBe(true);
      expect(rule.matches('delete_project')).toBe(true);
      expect(rule.matches('get_user')).toBe(false);
    });

    it('returns correct reason for deny', () => {
      const patterns = [compiler.compile('test', 'test')];
      const rule = new RegexMatchRule(patterns, 'deny');
      expect(rule.getReason()).toBe('deny_regex');
    });
  });

  describe('multiple patterns', () => {
    it('matches if any pattern matches', () => {
      const patterns = [
        compiler.compile('get_.*', 'test'),
        compiler.compile('list_.*', 'test'),
        compiler.compile('search_.*', 'test')
      ];
      const rule = new RegexMatchRule(patterns, 'allow');
      
      expect(rule.matches('get_user')).toBe(true);
      expect(rule.matches('list_users')).toBe(true);
      expect(rule.matches('search_items')).toBe(true);
      expect(rule.matches('delete_user')).toBe(false);
    });
  });

  describe('empty patterns', () => {
    it('never matches when patterns array is empty', () => {
      const rule = new RegexMatchRule([], 'allow');
      expect(rule.matches('anything')).toBe(false);
    });
  });
});
