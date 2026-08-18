/**
 * Shared `${env:VAR}` reference handling.
 *
 * Single source of truth for the exact-match env reference pattern and its
 * resolution, shared by load-time validation (`consent-gate-validator`), the
 * OAuth operational pre-flight check (`oauth-provider`) and runtime
 * resolution (`http-transport`, `oauth-provider`). Keeping one primitive
 * guarantees "validated at startup" and "resolves at login" cannot drift.
 *
 * Policy (throw vs warn vs default) stays at the call sites; this module only
 * provides the pattern and the neutral lookup.
 */

/** Read-only environment map; defaults to `process.env` at the call sites. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Exact-match `${env:VAR}` reference - the whole value must be the reference. */
export const ENV_REF_PATTERN = /^\$\{env:([^}]+)\}$/;

/**
 * Return the referenced env var name, or `undefined` when `value` is not an
 * exact-match `${env:VAR}` reference.
 */
export function matchEnvRefName(value: string): string | undefined {
  return value.match(ENV_REF_PATTERN)?.[1];
}

/**
 * Resolve an exact-match `${env:VAR}` reference against `env`.
 *
 * References resolve to the env var value: `undefined` when the var is unset,
 * the empty string when set but empty. Non-reference values pass through
 * unchanged. Never throws - callers decide how to treat unresolved refs.
 */
export function resolveEnvRef(value: string, env: EnvSource = process.env): string | undefined {
  const envVarName = matchEnvRefName(value);
  return envVarName !== undefined ? env[envVarName] : value;
}
