import { describe, it, expect } from 'vitest';
import { RegexValidator } from './regex-validator.js';

describe('RegexValidator', () => {
  describe('pattern length validation', () => {
    it('accepts patterns within max length', () => {
      const validator = new RegexValidator(100);
      const result = validator.validate('a'.repeat(50));
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('rejects patterns exceeding max length', () => {
      const validator = new RegexValidator(100);
      const result = validator.validate('a'.repeat(101));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds 100');
    });

    it('accepts patterns at exact max length', () => {
      const validator = new RegexValidator(100);
      const result = validator.validate('a'.repeat(100));
      expect(result.valid).toBe(true);
    });
  });

  describe('nested quantifiers detection', () => {
    it('rejects patterns with nested quantifiers', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(a+)+b');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nested quantifiers');
    });

    it('rejects patterns with nested star quantifiers', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(a*)*b');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nested quantifiers');
    });

    it('rejects patterns with nested range quantifiers', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(a{2,3})+b');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('nested quantifiers');
    });

    it('accepts patterns with single quantifiers', () => {
      const validator = new RegexValidator();
      const result = validator.validate('a+b*c{2,3}');
      expect(result.valid).toBe(true);
    });

    it('accepts patterns with quantifiers not nested', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(abc)+');
      expect(result.valid).toBe(true);
    });
  });

  describe('ambiguous alternation detection', () => {
    it('rejects alternation with quantifiers', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(a|aa)+');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('alternation');
    });

    it('rejects alternation with star quantifier', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(foo|foobar)*');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('alternation');
    });

    it('accepts alternation without quantifiers', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(a|b)');
      expect(result.valid).toBe(true);
    });

    it('accepts quantifiers with non-alternation groups', () => {
      const validator = new RegexValidator();
      const result = validator.validate('(abc)+');
      expect(result.valid).toBe(true);
    });
  });

  describe('combined validation', () => {
    it('rejects patterns with multiple issues', () => {
      const validator = new RegexValidator(20);
      const result = validator.validate('a'.repeat(30));
      expect(result.valid).toBe(false);
    });

    it('accepts valid complex patterns', () => {
      const validator = new RegexValidator();
      const result = validator.validate('^(get|read)_[a-z]+$');
      expect(result.valid).toBe(true);
    });
  });

  describe('custom max length', () => {
    it('respects custom max length in constructor', () => {
      const validator = new RegexValidator(50);
      expect(validator.validate('a'.repeat(51)).valid).toBe(false);
      expect(validator.validate('a'.repeat(50)).valid).toBe(true);
    });
  });
});
