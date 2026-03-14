import { describe, it, expect } from 'vitest';
import { RegexCompiler } from './regex-compiler.js';
import { RegexValidator } from './regex-validator.js';
import { InvalidRegexError } from '../errors.js';

describe('RegexCompiler', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);

  describe('auto-anchoring', () => {
    it('anchors unanchored patterns', () => {
      const compiled = compiler.compile('user', 'test');
      expect(compiled.original).toBe('user');
      expect(compiled.anchored).toBe('^user$');
      expect(compiled.regex.source).toBe('^user$');
    });

    it('preserves fully anchored patterns', () => {
      const compiled = compiler.compile('^user$', 'test');
      expect(compiled.anchored).toBe('^user$');
    });

    it('adds missing start anchor', () => {
      const compiled = compiler.compile('user$', 'test');
      expect(compiled.anchored).toBe('^user$');
    });

    it('adds missing end anchor', () => {
      const compiled = compiler.compile('^user', 'test');
      expect(compiled.anchored).toBe('^user$');
    });

    it('handles patterns with dots', () => {
      const compiled = compiler.compile('.*user.*', 'test');
      expect(compiled.anchored).toBe('^.*user.*$');
    });
  });

  describe('compilation', () => {
    it('compiles valid patterns', () => {
      const compiled = compiler.compile('get_.*', 'test');
      expect(compiled.test('get_user')).toBe(true);
      expect(compiled.test('get_project')).toBe(true);
      expect(compiled.test('list_user')).toBe(false);
    });

    it('throws InvalidRegexError for invalid patterns', () => {
      expect(() => compiler.compile('(', 'test')).toThrow(InvalidRegexError);
    });

    it('throws InvalidRegexError for patterns failing validation', () => {
      expect(() => compiler.compile('(a+)+', 'test')).toThrow(InvalidRegexError);
    });

    it('includes context in error message', () => {
      try {
        compiler.compile('(a+)+', 'MCP4_TEST');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidRegexError);
        expect((error as InvalidRegexError).context).toBe('MCP4_TEST');
        expect((error as InvalidRegexError).pattern).toBe('(a+)+');
        expect((error as InvalidRegexError).message).toContain('MCP4_TEST');
      }
    });
  });

  describe('CompiledRegex.test()', () => {
    it('tests values against compiled pattern', () => {
      const compiled = compiler.compile('read_.*', 'test');
      expect(compiled.test('read_user')).toBe(true);
      expect(compiled.test('read_project')).toBe(true);
      expect(compiled.test('delete_user')).toBe(false);
    });

    it('respects anchoring', () => {
      const compiled = compiler.compile('user', 'test');
      expect(compiled.test('user')).toBe(true);
      expect(compiled.test('get_user')).toBe(false);
      expect(compiled.test('user_admin')).toBe(false);
    });

    it('rejects inputs longer than the supported tool-name length boundary', () => {
      const compiled = compiler.compile('a+', 'test');
      expect(compiled.test('a'.repeat(255))).toBe(true);
      expect(compiled.test('a'.repeat(256))).toBe(false);
    });
  });

  describe('metadata preservation', () => {
    it('stores original pattern', () => {
      const compiled = compiler.compile('test_.*', 'ctx');
      expect(compiled.original).toBe('test_.*');
    });

    it('stores anchored pattern', () => {
      const compiled = compiler.compile('test', 'ctx');
      expect(compiled.anchored).toBe('^test$');
    });

    it('provides access to compiled regex', () => {
      const compiled = compiler.compile('test', 'ctx');
      expect(compiled.regex).toBeInstanceOf(RegExp);
    });
  });
});
