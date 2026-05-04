import { describe, it, expect } from 'vitest';
import { ConfigurationError } from '../core/errors.js';
import {
  parseProfilesDescriptionEnv,
  resolveProfileAdminDescriptions,
  PROFILES_DESCRIPTION_ENV_VAR,
} from './profile-description-env.js';
import type { ListedProfileDetails } from './profile-resolver.js';

function profile(
  profileId: string,
  profileName: string,
  profileAliases: string[] = []
): ListedProfileDetails {
  return {
    profileId,
    profileName,
    profileAliases,
    envVars: [],
    authMethods: [],
  };
}

describe('PROFILES_DESCRIPTION_ENV_VAR', () => {
  it('exposes the env-var name as a single source of truth', () => {
    expect(PROFILES_DESCRIPTION_ENV_VAR).toBe('MCP4_PROFILES_DESCRIPTION');
  });
});

describe('parseProfilesDescriptionEnv', () => {
  it('D-08: returns undefined when env var is unset (undefined)', () => {
    expect(parseProfilesDescriptionEnv(undefined)).toBeUndefined();
  });

  it('D-08: returns undefined when env var is empty string', () => {
    expect(parseProfilesDescriptionEnv('')).toBeUndefined();
  });

  it('D-08: returns undefined when env var is whitespace-only', () => {
    expect(parseProfilesDescriptionEnv('   \t\n')).toBeUndefined();
  });

  it('D-07: throws ConfigurationError on invalid JSON', () => {
    let caught: unknown;
    try {
      parseProfilesDescriptionEnv('{not valid json');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    const err = caught as ConfigurationError;
    expect(err.code).toBe('CONFIGURATION_ERROR');
    expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION is not valid JSON');
    expect(err.details?.envVar).toBe('MCP4_PROFILES_DESCRIPTION');
    expect(typeof err.details?.error).toBe('string');
    expect((err.details?.error as string).length).toBeGreaterThan(0);
  });

  it('D-02: throws ConfigurationError on JSON null', () => {
    try {
      parseProfilesDescriptionEnv('null');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION must be a JSON object');
      expect(err.details?.receivedType).toBe('null');
    }
  });

  it('D-02: throws ConfigurationError on JSON array', () => {
    try {
      parseProfilesDescriptionEnv('[]');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION must be a JSON object');
      expect(err.details?.receivedType).toBe('array');
    }
  });

  it('D-02: throws ConfigurationError on JSON string', () => {
    try {
      parseProfilesDescriptionEnv('"string"');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err.details?.receivedType).toBe('string');
    }
  });

  it('D-02: throws ConfigurationError on JSON number', () => {
    try {
      parseProfilesDescriptionEnv('42');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err.details?.receivedType).toBe('number');
    }
  });

  it('D-02 / D-03: throws when an entry value is a number, not a string', () => {
    try {
      parseProfilesDescriptionEnv('{"gitlab": 42}');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION values must be strings');
      expect(err.details?.envVar).toBe('MCP4_PROFILES_DESCRIPTION');
      expect(err.details?.key).toBe('gitlab');
      expect(err.details?.receivedType).toBe('number');
    }
  });

  it('D-02 / D-03: throws when an entry value is null', () => {
    try {
      parseProfilesDescriptionEnv('{"gitlab": null}');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION values must be strings');
      expect(err.details?.key).toBe('gitlab');
      expect(err.details?.receivedType).toBe('null');
    }
  });

  it('D-02 / D-06: returns Map preserving HTML and empty-string values', () => {
    const map = parseProfilesDescriptionEnv('{"gitlab":"<b>hi</b>","github":""}');
    expect(map).toBeInstanceOf(Map);
    expect(map?.size).toBe(2);
    expect(map?.get('gitlab')).toBe('<b>hi</b>');
    expect(map?.get('github')).toBe('');
  });

  it('Pitfall §2: literal duplicate JSON keys collapse to last-wins (parser-level, not D-05)', () => {
    const map = parseProfilesDescriptionEnv('{"gitlab":"a","gitlab":"b"}');
    expect(map?.size).toBe(1);
    expect(map?.get('gitlab')).toBe('b');
  });

  it('D-02 / D-03: throws when an entry value is a boolean', () => {
    try {
      parseProfilesDescriptionEnv('{"gitlab": true}');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION values must be strings');
      expect(err.details?.key).toBe('gitlab');
      expect(err.details?.receivedType).toBe('boolean');
    }
  });

  it('D-02 / D-03: throws when an entry value is a nested object', () => {
    try {
      parseProfilesDescriptionEnv('{"gitlab": {"html": "<b>x</b>"}}');
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION values must be strings');
      expect(err.details?.key).toBe('gitlab');
      expect(err.details?.receivedType).toBe('object');
    }
  });

  it('length limit: throws ConfigurationError when value exceeds 10000 characters', () => {
    const longValue = 'a'.repeat(10_001);
    try {
      parseProfilesDescriptionEnv(JSON.stringify({ gitlab: longValue }));
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION values must not exceed 10000 characters');
      expect(err.details?.key).toBe('gitlab');
      expect(err.details?.receivedLength).toBe(10_001);
    }
  });

  it('length limit: accepts value of exactly 10000 characters', () => {
    const exactValue = 'a'.repeat(10_000);
    const map = parseProfilesDescriptionEnv(JSON.stringify({ gitlab: exactValue }));
    expect(map?.get('gitlab')).toBe(exactValue);
  });
});

describe('resolveProfileAdminDescriptions', () => {
  it('D-09: returns empty map when descriptions is undefined', () => {
    const out = resolveProfileAdminDescriptions(undefined, [profile('p1', 'p1')]);
    expect(out).toBeInstanceOf(Map);
    expect(out.size).toBe(0);
  });

  it('D-09: returns empty map when descriptions is an empty Map', () => {
    const out = resolveProfileAdminDescriptions(new Map(), [profile('p1', 'p1')]);
    expect(out.size).toBe(0);
  });

  it('D-04: matches by profileId', () => {
    const out = resolveProfileAdminDescriptions(
      new Map([['gl', 'desc-by-id']]),
      [profile('gl', 'gitlab')]
    );
    expect(out.size).toBe(1);
    expect(out.get('gl')).toBe('desc-by-id');
  });

  it('D-04: matches by profileName', () => {
    const out = resolveProfileAdminDescriptions(
      new Map([['gitlab-internal', 'desc-by-name']]),
      [profile('p1', 'gitlab-internal')]
    );
    expect(out.size).toBe(1);
    expect(out.get('p1')).toBe('desc-by-name');
  });

  it('D-04: matches by alias entry', () => {
    const out = resolveProfileAdminDescriptions(
      new Map([['gl', 'desc-by-alias']]),
      [profile('gitlab', 'gitlab-internal', ['gl', 'gitlab-old'])]
    );
    expect(out.size).toBe(1);
    expect(out.get('gitlab')).toBe('desc-by-alias');
  });

  it('D-09: silently ignores keys that match no profile', () => {
    const out = resolveProfileAdminDescriptions(
      new Map([['unknown', 'orphan']]),
      [profile('p1', 'p1')]
    );
    expect(out.size).toBe(0);
  });

  it('D-05: distinct keys for distinct profiles is fine', () => {
    const out = resolveProfileAdminDescriptions(
      new Map([['gitlab', 'a'], ['gh-internal', 'b']]),
      [profile('gitlab', 'gitlab'), profile('github', 'gh-internal')]
    );
    expect(out.size).toBe(2);
    expect(out.get('gitlab')).toBe('a');
    expect(out.get('github')).toBe('b');
  });

  it('D-05: throws when profileId AND alias both match the same profile', () => {
    try {
      resolveProfileAdminDescriptions(
        new Map([['gitlab', 'a'], ['gl', 'b']]),
        [profile('gitlab', 'gitlab', ['gl'])]
      );
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(err.code).toBe('CONFIGURATION_ERROR');
      expect(err.message).toBe('MCP4_PROFILES_DESCRIPTION has multiple keys resolving to the same profile');
      expect(err.details?.envVar).toBe('MCP4_PROFILES_DESCRIPTION');
      expect(err.details?.profileId).toBe('gitlab');
      expect(err.details?.profileName).toBe('gitlab');
      expect(err.details?.conflictingKeys).toEqual(['gitlab', 'gl']);
    }
  });

  it('D-05: throws when profileName AND alias both match the same profile (sorted keys)', () => {
    try {
      resolveProfileAdminDescriptions(
        new Map([['gl', 'a'], ['gitlab', 'b']]),
        [profile('p1', 'gitlab', ['gl'])]
      );
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as ConfigurationError;
      expect(err.details?.conflictingKeys).toEqual(['gitlab', 'gl']);
    }
  });

  it('Pitfall §6 / D-09: empty-string description flows through resolution', () => {
    const out = resolveProfileAdminDescriptions(
      new Map([['gitlab', '']]),
      [profile('gitlab', 'gitlab')]
    );
    expect(out.size).toBe(1);
    expect(out.get('gitlab')).toBe('');
  });

  it('D-09: non-empty descriptions with empty profiles list returns empty map', () => {
    const out = resolveProfileAdminDescriptions(new Map([['gitlab', 'desc']]), []);
    expect(out.size).toBe(0);
  });

  it('false-conflict guard: single key matching profileId and profileName of same profile does not throw', () => {
    // profileId === profileName === key — matches both id and name conditions for the same key,
    // must not trigger D-05 conflict (existingKey !== key guard prevents false positive).
    const out = resolveProfileAdminDescriptions(
      new Map([['gitlab', 'desc']]),
      [profile('gitlab', 'gitlab')]
    );
    expect(out.size).toBe(1);
    expect(out.get('gitlab')).toBe('desc');
  });
});
