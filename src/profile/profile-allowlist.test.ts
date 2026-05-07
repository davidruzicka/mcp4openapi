import { describe, it, expect } from 'vitest';
import { ConfigurationError } from '../core/errors.js';
import { isProfileAllowed, isProfileHidden, parseProfileAllowlistConfig, parseProfileHidelistConfig } from './profile-allowlist.js';

describe('profile allowlist', () => {
  it('returns null when no allowlist inputs are provided', () => {
    expect(parseProfileAllowlistConfig({})).toBeNull();
  });

  it('rejects invalid allowlist regex', () => {
    expect(() => parseProfileAllowlistConfig({ allowNameRegex: '[' })).toThrow(ConfigurationError);
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

describe('profile hidelist', () => {
  it('returns empty array for undefined input', () => {
    expect(parseProfileHidelistConfig(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseProfileHidelistConfig('')).toEqual([]);
  });

  it('splits comma-separated values and trims whitespace', () => {
    expect(parseProfileHidelistConfig('a, b , c')).toEqual(['a', 'b', 'c']);
  });

  it('filters empty segments', () => {
    expect(parseProfileHidelistConfig('a,,b,')).toEqual(['a', 'b']);
  });

  it('returns false for empty hidelist', () => {
    const profile = { profileId: 'x', profileName: 'x' };
    expect(isProfileHidden(profile, [])).toBe(false);
  });

  it('matches by profileId', () => {
    const profile = { profileId: 'secret', profileName: 'Secret API' };
    expect(isProfileHidden(profile, ['secret'])).toBe(true);
  });

  it('matches by profileName', () => {
    const profile = { profileId: 'secret', profileName: 'Secret API' };
    expect(isProfileHidden(profile, ['Secret API'])).toBe(true);
  });

  it('matches by alias', () => {
    const profile = { profileId: 'secret', profileName: 'Secret API', profileAliases: ['old-secret'] };
    expect(isProfileHidden(profile, ['old-secret'])).toBe(true);
  });

  it('does not hide unrelated profile', () => {
    const profile = { profileId: 'public', profileName: 'Public API' };
    expect(isProfileHidden(profile, ['secret'])).toBe(false);
  });

  it('matching is case-sensitive', () => {
    const profile = { profileId: 'secret', profileName: 'secret' };
    expect(isProfileHidden(profile, ['SECRET'])).toBe(false);
  });
});
