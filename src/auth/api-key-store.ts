import type { AuthorizedPrincipal } from './inbound-auth-principal.js';

/**
 * Pluggable interface for M2M API key validation.
 *
 * Implementations resolve a raw API key string to an `AuthorizedPrincipal`,
 * or `null` when the key does not match any configured entry. Implementations
 * MUST use constant-time comparison to prevent timing attacks.
 *
 * Phase 3 ships `InlineApiKeyStore`. Phase 4 adds `SasankaApiKeyStore` and a
 * factory entry keyed off `ApiKeyStoreConfig.type`.
 */
export interface ApiKeyStore {
  validate(key: string): Promise<AuthorizedPrincipal | null>;
}
