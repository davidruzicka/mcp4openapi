import { describe, it, expect } from 'vitest';
import { ConfigurationError } from '../core/errors.js';
import { isProfileAllowed, parseProfileAllowlistConfig } from './profile-allowlist.js';

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
