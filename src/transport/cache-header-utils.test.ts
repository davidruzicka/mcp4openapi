import { describe, expect, it } from 'vitest';
import {
  getDirectiveValue,
  getHeaderValueCaseInsensitive,
  hasDirective,
  parseCacheControl,
  parseNonNegativeInteger,
  parseVaryHeader,
} from './cache-header-utils.js';

describe('cache-header-utils', () => {
  it('reads header values case-insensitively', () => {
    const value = getHeaderValueCaseInsensitive(
      { 'Content-Type': 'application/json', 'CACHE-control': 'max-age=60' },
      'cache-control'
    );

    expect(value).toBe('max-age=60');
  });

  it('parses cache-control directives and quoted values', () => {
    const directives = parseCacheControl('max-age=60, no-store, stale-while-revalidate="30"');

    expect(getDirectiveValue(directives, 'max-age')).toBe('60');
    expect(hasDirective(directives, 'no-store')).toBe(true);
    expect(getDirectiveValue(directives, 'stale-while-revalidate')).toBe('30');
  });

  it('returns undefined for missing directive values', () => {
    const directives = parseCacheControl('no-cache');

    expect(getDirectiveValue(directives, 'max-age')).toBeUndefined();
  });

  it('parses only non-negative integers', () => {
    expect(parseNonNegativeInteger('0')).toBe(0);
    expect(parseNonNegativeInteger('123')).toBe(123);
    expect(parseNonNegativeInteger('01')).toBe(1);
    expect(parseNonNegativeInteger('-1')).toBeUndefined();
    expect(parseNonNegativeInteger('12.5')).toBeUndefined();
    expect(parseNonNegativeInteger('abc')).toBeUndefined();
  });

  it('parses vary header and detects wildcard', () => {
    const explicit = parseVaryHeader('Accept-Language, Accept-Encoding');
    expect(explicit.star).toBe(false);
    expect(explicit.headers).toEqual(new Set(['accept-language', 'accept-encoding']));

    const wildcard = parseVaryHeader(' * ');
    expect(wildcard.star).toBe(true);
    expect(wildcard.headers.size).toBe(0);
  });
});
