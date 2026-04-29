/**
 * ClientAuthGate (Phase 3, API key path only) — orchestrator tests.
 *
 * Phase 4 will add a JWT path to this same class. These tests pin the
 * API-key-only behavior so the JWT addition cannot regress it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClientAuthGate } from './client-auth-gate.js';
import { ClientAuthGateError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

const makeLogger = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as Logger;

const VALID_KEY = 'super-secret-api-key';
const ENV_VAR = 'CLIENT_AUTH_GATE_TEST_KEY_1';

describe('ClientAuthGate (API key path only)', () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[ENV_VAR];
    process.env[ENV_VAR] = VALID_KEY;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prevEnv;
  });

  it('returns AuthorizedPrincipal with authType="token" for a configured API key', async () => {
    const gate = new ClientAuthGate(
      'profile-a',
      {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: ENV_VAR, subject: 'service-a', scopes: ['read'] }],
        },
      },
      makeLogger(),
    );

    const principal = await gate.validate(VALID_KEY);

    expect(principal).not.toBeNull();
    expect(principal!.authType).toBe('token');
    expect(principal!.subject).toBe('service-a');
    expect(principal!.profileId).toBe('profile-a');
    expect(principal!.scopes).toEqual(['read']);
  });

  it('throws ClientAuthGateError when API key is invalid and mode=required', async () => {
    const gate = new ClientAuthGate(
      'profile-a',
      {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: ENV_VAR, subject: 'service-a' }],
        },
      },
      makeLogger(),
    );

    await expect(gate.validate('wrong-key')).rejects.toBeInstanceOf(ClientAuthGateError);
  });

  it('returns null when API key is invalid and mode=optional', async () => {
    const gate = new ClientAuthGate(
      'profile-a',
      {
        mode: 'optional',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: ENV_VAR, subject: 'service-a' }],
        },
      },
      makeLogger(),
    );

    const result = await gate.validate('wrong-key');
    expect(result).toBeNull();
  });

  it('returns null when no token presented and mode=optional', async () => {
    const gate = new ClientAuthGate(
      'profile-a',
      {
        mode: 'optional',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: ENV_VAR, subject: 'service-a' }],
        },
      },
      makeLogger(),
    );

    const result = await gate.validate(undefined);
    expect(result).toBeNull();
  });

  it('throws ClientAuthGateError when no token presented and mode=required', async () => {
    const gate = new ClientAuthGate(
      'profile-a',
      {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: ENV_VAR, subject: 'service-a' }],
        },
      },
      makeLogger(),
    );

    await expect(gate.validate(undefined)).rejects.toBeInstanceOf(ClientAuthGateError);
  });

  it('defaults mode to "required" when omitted (closed by default)', async () => {
    const gate = new ClientAuthGate(
      'profile-a',
      {
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: ENV_VAR, subject: 'service-a' }],
        },
      },
      makeLogger(),
    );

    await expect(gate.validate(undefined)).rejects.toBeInstanceOf(ClientAuthGateError);
    await expect(gate.validate('wrong-key')).rejects.toBeInstanceOf(ClientAuthGateError);
  });

  it('returns null when mode=optional and no api_keys store is configured', async () => {
    const gate = new ClientAuthGate(
      'profile-a',
      { mode: 'optional' },
      makeLogger(),
    );

    expect(await gate.validate(undefined)).toBeNull();
    expect(await gate.validate('any-token')).toBeNull();
  });

  it('resolves mode from mode_from_env when env var is set to optional', async () => {
    const modeEnv = 'CLIENT_AUTH_GATE_TEST_MODE';
    process.env[modeEnv] = 'optional';
    try {
      const gate = new ClientAuthGate(
        'profile-a',
        {
          mode_from_env: modeEnv,
          api_keys: {
            type: 'inline',
            keys: [{ key_from_env: ENV_VAR, subject: 'service-a' }],
          },
        },
        makeLogger(),
      );
      expect(await gate.validate('wrong-key')).toBeNull();
    } finally {
      delete process.env[modeEnv];
    }
  });

  it('throws ClientAuthGateError in constructor when mode_from_env env var is not set', () => {
    expect(
      () =>
        new ClientAuthGate(
          'profile-a',
          { mode_from_env: 'CLIENT_AUTH_GATE_TEST_MODE_UNSET' },
          makeLogger(),
        ),
    ).toThrow(ClientAuthGateError);
  });

  it('throws ClientAuthGateError in constructor when mode_from_env env var has invalid value', () => {
    const modeEnv = 'CLIENT_AUTH_GATE_TEST_MODE';
    process.env[modeEnv] = 'superuser';
    try {
      expect(
        () =>
          new ClientAuthGate(
            'profile-a',
            { mode_from_env: modeEnv },
            makeLogger(),
          ),
      ).toThrow(ClientAuthGateError);
    } finally {
      delete process.env[modeEnv];
    }
  });

  it('Phase 3 sanity: client-auth-gate.ts contains no JWT/JWKS imports', async () => {
    // Pin Phase 4 deferral: importing ClientAuthGate must NOT pull in jose/jwks-cache.
    // Read the source file and assert the absence of those imports/runtime calls.
    // We match `import` statements and direct calls (not arbitrary comment text)
    // so the file can document Phase 4 plans inline without tripping this guard.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const sourcePath = url.fileURLToPath(new URL('./client-auth-gate.ts', import.meta.url));
    const source = fs.readFileSync(sourcePath, 'utf8');

    // No `import ... from 'jose'` or `import ... from '...jwks-cache.js'`
    expect(source).not.toMatch(/^\s*import[\s\S]+?from\s+['"]jose['"];?/m);
    expect(source).not.toMatch(/^\s*import[\s\S]+?from\s+['"][^'"]*jwks-cache[^'"]*['"];?/m);

    // No runtime calls into jose primitives that the Phase 4 design uses.
    // Match `decodeProtectedHeader(` or `jwtVerify(` (not the string in JSDoc).
    expect(source).not.toMatch(/\bdecodeProtectedHeader\s*\(/);
    expect(source).not.toMatch(/\bjwtVerify\s*\(/);
    expect(source).not.toMatch(/\bcreateLocalJWKSet\s*\(/);
    expect(source).not.toMatch(/\bnew\s+JwksCache\s*\(/);
  });
});
