/**
 * Client authentication gate profile validator
 *
 * Why: All downstream client-auth-gate code (Phase 3 plans 02 + 03) depends on
 * a stable, normalized config. Validating at profile load time turns
 * misconfigured gates into fast, actionable startup errors instead of silent
 * runtime failures (e.g. all API keys silently rejected because an env var was
 * unset).
 *
 * Phase 3 supports only `api_keys` of type `inline`. Phase 4 will extend this
 * validator with `api_keys.type = 'sasanka'` and `jwt` (OIDC) blocks.
 */

import { ClientAuthGateError } from '../core/errors.js';
import type { ApiKeyStoreConfig, ClientAuthGateConfig, Profile } from '../types/profile.js';

function resolveEnv(
  value: string | undefined,
  fromEnv: string | undefined,
  fieldPath: string,
): string | undefined {
  if (value) return value;
  if (fromEnv) {
    const resolved = process.env[fromEnv];
    if (!resolved) {
      throw new ClientAuthGateError(`${fieldPath}: env var '${fromEnv}' is not set`, {
        path: fieldPath,
        envVar: fromEnv,
      });
    }
    return resolved;
  }
  return undefined;
}

export function validateClientAuthGateProfile(profile: Profile): ClientAuthGateConfig | undefined {
  const config = profile.client_auth_gate;
  if (!config) return undefined;

  // Mutual exclusion: client_auth_gate cannot coexist with OAuth interceptors.
  // Why: OAuth interceptors authenticate the gateway *to upstream* APIs, while
  // the client gate authenticates *inbound* clients. Combining the two on a
  // single profile creates ambiguous identity flows; operators must split into
  // separate profiles.
  const auths = profile.interceptors?.auth
    ? Array.isArray(profile.interceptors.auth)
      ? profile.interceptors.auth
      : [profile.interceptors.auth]
    : [];
  if (auths.some((a) => a.type === 'oauth')) {
    throw new ClientAuthGateError(
      'client_auth_gate cannot be combined with OAuth interceptors; configure one inbound auth method per profile',
      { path: 'client_auth_gate' },
    );
  }
  if (auths.some((a) => a.validation_endpoint)) {
    throw new ClientAuthGateError(
      'client_auth_gate cannot be combined with auth interceptors that have validation_endpoint; configure separate profiles',
      { path: 'client_auth_gate' },
    );
  }

  // Resolve mode (default to 'required' when neither inline value nor env override is set).
  const resolvedMode =
    resolveEnv(config.mode, config.mode_from_env, 'client_auth_gate.mode') ?? 'required';
  if (resolvedMode !== 'required' && resolvedMode !== 'optional') {
    throw new ClientAuthGateError(
      `client_auth_gate.mode must be 'required' or 'optional', got '${resolvedMode}'`,
      { path: 'client_auth_gate.mode', value: resolvedMode },
    );
  }
  const mode: 'required' | 'optional' = resolvedMode;

  // Validate api_keys block.
  let apiKeys: ApiKeyStoreConfig | undefined = config.api_keys
    ? ({ ...config.api_keys } as ApiKeyStoreConfig)
    : undefined;
  if (apiKeys) {
    if (apiKeys.type !== 'inline') {
      throw new ClientAuthGateError(
        `client_auth_gate.api_keys.type '${apiKeys.type}' is not supported. Allowed: inline`,
        { path: 'client_auth_gate.api_keys.type', value: apiKeys.type },
      );
    }
    if (apiKeys.type === 'inline') {
      if (!apiKeys.keys?.length) {
        throw new ClientAuthGateError(
          'client_auth_gate.api_keys.keys must be a non-empty array for type=inline',
          { path: 'client_auth_gate.api_keys.keys' },
        );
      }
      for (const entry of apiKeys.keys) {
        if (!entry.key_from_env?.trim()) {
          throw new ClientAuthGateError(
            'client_auth_gate.api_keys.keys[].key_from_env is required',
            { path: 'client_auth_gate.api_keys.keys[].key_from_env' },
          );
        }
        if (!entry.subject?.trim()) {
          throw new ClientAuthGateError(
            'client_auth_gate.api_keys.keys[].subject is required',
            { path: 'client_auth_gate.api_keys.keys[].subject' },
          );
        }
        // Fail-fast: catch misconfigured env vars at load time so operators get
        // an actionable error instead of silent all-key rejection at runtime.
        if (!process.env[entry.key_from_env]?.trim()) {
          throw new ClientAuthGateError(
            `client_auth_gate.api_keys.keys[].key_from_env: env var '${entry.key_from_env}' is not set`,
            {
              path: 'client_auth_gate.api_keys.keys[].key_from_env',
              envVar: entry.key_from_env,
            },
          );
        }
      }
    }
    // Phase 4 adds sasanka branch here
  }

  if (!apiKeys && mode === 'required') {
    throw new ClientAuthGateError(
      'client_auth_gate: api_keys must be configured when mode=required (jwt support added in Phase 4)',
      { path: 'client_auth_gate' },
    );
  }

  return { mode, api_keys: apiKeys };
}
