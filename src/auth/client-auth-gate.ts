import type { Logger } from '../core/logger.js';
import type { ClientAuthGateConfig } from '../types/profile.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import { createApiKeyStore } from './api-key-store-factory.js';
import type { ApiKeyStore } from './api-key-store.js';
import { ClientAuthGateError } from '../core/errors.js';

/**
 * Inbound client authentication gate orchestrator (Phase 3 — API key path only).
 *
 * `validate(token)` resolves a raw inbound token to an `AuthorizedPrincipal`
 * using the configured `ApiKeyStore`. The result feeds `SessionData.clientPrincipal`
 * and downstream policy/audit (Phase 5).
 *
 * ## Phase 3 vs Phase 4
 *
 * Phase 3 implements only the API key path (`config.api_keys`). Phase 4 will
 * extend this same class with a JWT path (decode-and-route, JWKS validation
 * via `JwksCache`). The constructor signature stays additive: Phase 4 will
 * accept a `JwksCache` injection without breaking the Phase 3 call site.
 *
 * Why API-key-only here (rather than collapsing into `InlineApiKeyStore`):
 *   1. Single inbound entry point per session — the transport always calls
 *      `gate.validate(token)`, regardless of which backend resolves it.
 *   2. Mode handling (`required` vs `optional`) is a gate-level concern, not
 *      a store concern: a store that returns `null` doesn't know whether
 *      that should produce 401 or an anonymous session.
 *   3. Phase 4's JWT path slots in here without duplicating the mode logic.
 */
export class ClientAuthGate {
  private readonly config: ClientAuthGateConfig;
  // Logger is unused on the Phase 3 happy path (the API key store is silent
  // on success and `null`-on-failure), but is retained for Phase 4 (JWT
  // validation needs structured logs for JWKS misses, kid mismatches, etc.).
  // Keeping the field private + readonly keeps the constructor signature
  // additive across phases.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly logger: Logger;
  private readonly apiKeyStore?: ApiKeyStore;

  constructor(profileId: string, config: ClientAuthGateConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    if (config.api_keys) {
      this.apiKeyStore = createApiKeyStore(config.api_keys, profileId, logger);
    }
  }

  /**
   * Resolve an inbound token to an `AuthorizedPrincipal`.
   *
   * Returns `null` only when `mode === 'optional'` and no identity could be
   * resolved. Throws `ClientAuthGateError` when `mode === 'required'` and no
   * identity is resolved.
   *
   * Phase 3: only the API key store is consulted. Phase 4 inserts JWT routing
   * BEFORE the API key store call (JWT-first), based on `decodeProtectedHeader`.
   */
  async validate(token: string | undefined): Promise<AuthorizedPrincipal | null> {
    const mode = this.config.mode ?? 'required';

    if (!token) {
      if (mode === 'optional') return null;
      throw new ClientAuthGateError(
        'Client authentication required: no token presented',
      );
    }

    // Phase 4 inserts JWT path here (jose decodeProtectedHeader + JwksCache).
    if (this.apiKeyStore) {
      const keyResult = await this.apiKeyStore.validate(token);
      if (keyResult !== null) return keyResult;
    }

    if (mode === 'required') {
      throw new ClientAuthGateError(
        'Client authentication required: no valid identity resolved',
      );
    }
    return null;
  }
}
