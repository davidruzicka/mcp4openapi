import { describe, it, expect, afterEach } from 'vitest';
import { ENV_REF_PATTERN, matchEnvRefName, resolveEnvRef } from './env-ref.js';

describe('ENV_REF_PATTERN', () => {
  it('matches only exact-match references (no prefix/suffix around the reference)', () => {
    expect(ENV_REF_PATTERN.test('${env:MY_VAR}')).toBe(true);
    expect(ENV_REF_PATTERN.test('prefix-${env:MY_VAR}')).toBe(false);
    expect(ENV_REF_PATTERN.test('${env:MY_VAR}-suffix')).toBe(false);
    expect(ENV_REF_PATTERN.test('${env:}')).toBe(false);
  });
});

describe('matchEnvRefName', () => {
  it('returns the referenced env var name for an exact-match reference', () => {
    expect(matchEnvRefName('${env:MY_VAR}')).toBe('MY_VAR');
  });

  it('returns undefined for non-reference values', () => {
    expect(matchEnvRefName('https://example.test')).toBeUndefined();
    expect(matchEnvRefName('')).toBeUndefined();
    expect(matchEnvRefName('env:MY_VAR')).toBeUndefined();
  });

  it('returns undefined for embedded references (interpolation is out of scope)', () => {
    expect(matchEnvRefName('https://${env:HOST}/callback')).toBeUndefined();
  });
});

describe('resolveEnvRef', () => {
  const TEST_VAR = 'MCP4_ENV_REF_UNIT_TEST_VAR';

  afterEach(() => {
    delete process.env[TEST_VAR];
  });

  it('passes non-reference values through unchanged', () => {
    expect(resolveEnvRef('literal-value', {})).toBe('literal-value');
    expect(resolveEnvRef('', {})).toBe('');
  });

  it('resolves a reference to the env var value', () => {
    expect(resolveEnvRef('${env:MY_VAR}', { MY_VAR: 'resolved' })).toBe('resolved');
  });

  it('returns undefined when the referenced var is unset', () => {
    expect(resolveEnvRef('${env:MISSING_VAR}', {})).toBeUndefined();
  });

  it('returns the empty string when the referenced var is set but empty', () => {
    expect(resolveEnvRef('${env:EMPTY_VAR}', { EMPTY_VAR: '' })).toBe('');
  });

  it('preserves whitespace-only values (blankness policy belongs to callers)', () => {
    expect(resolveEnvRef('${env:BLANK_VAR}', { BLANK_VAR: '  ' })).toBe('  ');
  });

  it('defaults to process.env when no env source is injected', () => {
    process.env[TEST_VAR] = 'from-process-env';
    expect(resolveEnvRef(`\${env:${TEST_VAR}}`)).toBe('from-process-env');
    delete process.env[TEST_VAR];
    expect(resolveEnvRef(`\${env:${TEST_VAR}}`)).toBeUndefined();
  });
});
