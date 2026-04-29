import type { Logger } from '../core/logger.js';
import type { ApiKeyStoreConfig } from '../types/profile.js';
import type { ApiKeyStore } from './api-key-store.js';
import { InlineApiKeyStore } from './inline-api-key-store.js';
import { ClientAuthGateError } from '../core/errors.js';

/**
 * Construct an `ApiKeyStore` for a given `ApiKeyStoreConfig`.
 *
 * Phase 3 supports only `'inline'`. Phase 4 will add a `'sasanka'` branch
 * to this function (centralized key service) — keep the `Logger` parameter
 * even though it is unused for `'inline'` so the Phase 4 signature stays
 * additive (no breaking change for callers).
 *
 * Why a direct `if`/`else` instead of a registry table:
 *   - `ApiKeyStoreConfig` ships as a one-armed discriminated union in Phase 3.
 *     A `Record<string, Creator>` registry would force the unsupported-type
 *     guard to live as unreachable dead code (TypeScript narrowing already
 *     proves `config.type === 'inline'`), and would not let the compiler
 *     flag the missing branch when Phase 4 adds `'sasanka'` to the union.
 *   - With an explicit `if`, Phase 4's union widening triggers a TS error
 *     here until the new branch is added — the type system enforces what a
 *     registry table cannot.
 */
export function createApiKeyStore(
  config: ApiKeyStoreConfig,
  profileId: string,
  _logger: Logger,
): ApiKeyStore {
  if (config.type === 'inline') {
    return new InlineApiKeyStore(profileId, config.keys);
  }
  // Unreachable in Phase 3 (config.type is narrowed to 'inline'); this guard
  // exists for runtime defense against malformed config that bypassed Zod.
  // Phase 4 adds: if (config.type === 'sasanka') return new SasankaApiKeyStore(...)
  throw new ClientAuthGateError(
    `Unsupported api_keys.type: '${(config as { type: string }).type}'. Allowed: inline`,
  );
}
