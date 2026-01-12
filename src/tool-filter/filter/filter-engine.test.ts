import { describe, it, expect } from 'vitest';
import { FilterEngine, FilterResult } from './filter-engine.js';
import { ExactMatchRule, RegexMatchRule } from './filter-rules.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';

describe('FilterEngine', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);

  describe('no rules (allow all)', () => {
    it('allows all tools when no rules defined', () => {
      const engine = new FilterEngine([], []);
      const result = engine.evaluate('any_tool');
      
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('deny rules precedence', () => {
    it('denies tools matching deny list even if in allow list', () => {
      const allowRule = new ExactMatchRule(new Set(['get_user', 'delete_user']), 'allow');
      const denyRule = new ExactMatchRule(new Set(['delete_user']), 'deny');
      
      const engine = new FilterEngine([allowRule], [denyRule]);
      
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('delete_user').allowed).toBe(false);
      expect(engine.evaluate('delete_user').reason).toBe('deny_list');
    });

    it('checks deny rules before allow rules', () => {
      const allowPattern = compiler.compile('.*_user', 'test');
      const denyPattern = compiler.compile('delete_.*', 'test');
      
      const allowRule = new RegexMatchRule([allowPattern], 'allow');
      const denyRule = new RegexMatchRule([denyPattern], 'deny');
      
      const engine = new FilterEngine([allowRule], [denyRule]);
      
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('delete_user').allowed).toBe(false);
    });
  });

  describe('allow rules', () => {
    it('rejects tools not matching allow rules', () => {
      const allowRule = new ExactMatchRule(new Set(['get_user', 'list_users']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('list_users').allowed).toBe(true);
      expect(engine.evaluate('delete_user').allowed).toBe(false);
    });

    it('accepts if any allow rule matches', () => {
      const exactRule = new ExactMatchRule(new Set(['exact_match']), 'allow');
      const patternRule = new RegexMatchRule([compiler.compile('pattern_.*', 'test')], 'allow');
      
      const engine = new FilterEngine([exactRule, patternRule], []);
      
      expect(engine.evaluate('exact_match').allowed).toBe(true);
      expect(engine.evaluate('pattern_foo').allowed).toBe(true);
      expect(engine.evaluate('other').allowed).toBe(false);
    });

    it('returns reason when denied by allow rules', () => {
      const allowRule = new ExactMatchRule(new Set(['allowed']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      const result = engine.evaluate('denied');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('no_allow_match');
    });
  });

  describe('tool name normalization', () => {
    it('normalizes tool names before matching', () => {
      // Unicode composition: café vs cafe\u0301
      const allowRule = new ExactMatchRule(new Set(['café']), 'allow');
      const engine = new FilterEngine([allowRule], []);
      
      expect(engine.evaluate('cafe\u0301').allowed).toBe(true);
    });
  });

  describe('FilterResult', () => {
    it('creates allowed result', () => {
      const result = FilterResult.allowed('test_reason');
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('test_reason');
    });

    it('creates allowed result without reason', () => {
      const result = FilterResult.allowed();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('creates denied result', () => {
      const result = FilterResult.denied('deny_reason');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('deny_reason');
    });
  });

  describe('complex scenarios', () => {
    it('handles multiple allow and deny rules', () => {
      const allowExact = new ExactMatchRule(new Set(['get_user', 'list_users']), 'allow');
      const allowPattern = new RegexMatchRule([compiler.compile('read_.*', 'test')], 'allow');
      const denyExact = new ExactMatchRule(new Set(['read_secret']), 'deny');
      const denyPattern = new RegexMatchRule([compiler.compile('.*_admin', 'test')], 'deny');
      
      const engine = new FilterEngine([allowExact, allowPattern], [denyExact, denyPattern]);
      
      // Allowed by exact
      expect(engine.evaluate('get_user').allowed).toBe(true);
      expect(engine.evaluate('list_users').allowed).toBe(true);
      
      // Allowed by pattern
      expect(engine.evaluate('read_item').allowed).toBe(true);
      
      // Denied by exact
      expect(engine.evaluate('read_secret').allowed).toBe(false);
      
      // Denied by pattern
      expect(engine.evaluate('get_admin').allowed).toBe(false);
      expect(engine.evaluate('list_admin').allowed).toBe(false);
      
      // Not in allow list
      expect(engine.evaluate('delete_user').allowed).toBe(false);
    });

    it('stores reason from matching rule', () => {
      const allowRule = new ExactMatchRule(new Set(['allowed']), 'allow');
      const denyRule = new RegexMatchRule([compiler.compile('deny_.*', 'test')], 'deny');
      
      const engine = new FilterEngine([allowRule], [denyRule]);
      
      expect(engine.evaluate('allowed').reason).toBe('allow_list');
      expect(engine.evaluate('deny_something').reason).toBe('deny_regex');
      expect(engine.evaluate('other').reason).toBe('no_allow_match');
    });
  });
});
