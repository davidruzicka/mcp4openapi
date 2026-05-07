import { describe, it, expect } from 'vitest';
import { ConfigurationError } from '../core/errors.js';
import { isProfileAllowed, isProfileHidden, parseProfileAllowlistConfig, parseHiddenProfilesConfig } from './profile-filters.js';

describe('profile allowlist', () => {
  it('returns null when no allowlist inputs are provided', () => {
    expect(parseProfileAllowlistConfig({})).toBeNull();
  });

  it('rejects invalid allowlist regex', () => {
    expect(() => parseProfileAllowlistConfig({ allowNameRegex: '[' })).toThrow(ConfigurationError);
  });

  it('returns true when config is null (no allowlist)', () => {
    const profile = { profileId: 'any', profileName: 'Any Profile' };
    expect(isProfileAllowed(profile, null)).toBe(true);
  });

  it('matches by profile id', () => {
    const config = parseProfileAllowlistConfig({ allowNames: 'id-1' });
    expect(isProfileAllowed({ profileId: 'id-1', profileName: 'Something Else' }, config)).toBe(true);
  });

  it('matches by profile name', () => {
    const config = parseProfileAllowlistConfig({ allowNames: 'my-api' });
    expect(isProfileAllowed({ profileId: 'id-1', profileName: 'my-api' }, config)).toBe(true);
  });

  it('matches by alias', () => {
    const config = parseProfileAllowlistConfig({ allowNames: 'alias-1' });
    expect(isProfileAllowed({ profileId: 'id-1', profileName: 'name-1', profileAliases: ['alias-1'] }, config)).toBe(true);
  });

  it('matches by regex only when names miss', () => {
    const config = parseProfileAllowlistConfig({ allowNames: 'other', allowNameRegex: '^name-' });
    const profile = { profileId: 'id-1', profileName: 'name-1', profileAliases: [] };
    expect(isProfileAllowed(profile, config)).toBe(true);
  });

  it('returns false when profile matches neither names nor regex', () => {
    const config = parseProfileAllowlistConfig({ allowNames: 'allowed', allowNameRegex: '^team-' });
    const profile = { profileId: 'blocked', profileName: 'blocked', profileAliases: [] };
    expect(isProfileAllowed(profile, config)).toBe(false);
  });

  it('matches allowlist against profile id, name, and aliases', () => {
    const config = parseProfileAllowlistConfig({ allowNames: 'alias-1', allowNameRegex: '^name-' });
    expect(config).not.toBeNull();
    const profile = {
      profileId: 'id-1',
      profileName: 'name-1',
      profileAliases: ['alias-1'],
    };
    expect(isProfileAllowed(profile, config)).toBe(true);
  });
});

describe('profile hiddenProfiles', () => {
  it('returns empty set for undefined input', () => {
    expect(parseHiddenProfilesConfig(undefined)).toEqual(new Set());
  });

  it('returns empty set for empty string', () => {
    expect(parseHiddenProfilesConfig('')).toEqual(new Set());
  });

  it('splits comma-separated values and trims whitespace', () => {
    expect(parseHiddenProfilesConfig('a, b , c')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('filters empty segments', () => {
    expect(parseHiddenProfilesConfig('a,,b,')).toEqual(new Set(['a', 'b']));
  });

  it('returns false for empty hiddenProfiles', () => {
    const profile = { profileId: 'x', profileName: 'x' };
    expect(isProfileHidden(profile, new Set())).toBe(false);
  });

  it('matches by profileId', () => {
    const profile = { profileId: 'secret', profileName: 'Secret API' };
    expect(isProfileHidden(profile, new Set(['secret']))).toBe(true);
  });

  it('matches by profileName', () => {
    const profile = { profileId: 'secret', profileName: 'Secret API' };
    expect(isProfileHidden(profile, new Set(['Secret API']))).toBe(true);
  });

  it('matches by alias', () => {
    const profile = { profileId: 'secret', profileName: 'Secret API', profileAliases: ['old-secret'] };
    expect(isProfileHidden(profile, new Set(['old-secret']))).toBe(true);
  });

  it('does not hide unrelated profile', () => {
    const profile = { profileId: 'public', profileName: 'Public API' };
    expect(isProfileHidden(profile, new Set(['secret']))).toBe(false);
  });

  it('matching is case-sensitive', () => {
    const profile = { profileId: 'secret', profileName: 'secret' };
    expect(isProfileHidden(profile, new Set(['SECRET']))).toBe(false);
  });
});
