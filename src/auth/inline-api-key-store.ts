import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import type { ApiKeyStore } from './api-key-store.js';
import type { InlineApiKeyEntry } from '../types/profile.js';

/**
 * In-memory API key store backed by inline profile config.
 *
 * Each `InlineApiKeyEntry` references an env var (`key_from_env`) that holds
 * the raw API key value, plus a stable `subject` for the resolved principal
 * and optional `scopes`. Validation walks the configured entries in order and
 * returns the first match's `AuthorizedPrincipal` (or `null` when no entry
 * matches the supplied key).
 *
 * ## Constant-time comparison
 *
 * To prevent timing side-channels — including length-based ones —
 * `validate()` HMAC-SHA256s both the supplied and configured keys with a
 * per-instance random secret, then compares the two 32-byte digests via
 * `timingSafeEqual`. Because HMAC-SHA256 always emits a 32-byte buffer,
 * `timingSafeEqual` is invoked on equal-length inputs regardless of the
 * raw key lengths — erasing length as a timing leak.
 *
 * ## Why per-instance HMAC key
 *
 * The HMAC secret is generated once per `InlineApiKeyStore` instance and
 * never leaves memory. It exists purely to normalize comparison length;
 * the secret itself adds no meaningful confidentiality (an attacker who
 * already has heap access has worse problems). The point is that the
 * digest of any string under this secret is always 32 bytes — no length
 * padding, branching, or early exit.
 *
 * ## Why HMAC is recomputed per call (not pre-computed at construction)
 *
 * `InlineApiKeyStore` targets small deployments — typically 1-5 keys — so
 * the per-call HMAC cost is negligible compared to the cost of a single
 * inbound MCP request. Pre-computed digests would add mutable state and
 * env-var-rotation complexity (when does a digest invalidate?) without a
 * measurable latency benefit at this scale. Phase 4's `SasankaApiKeyStore`
 * uses a different validation model (network call) so this trade-off
 * doesn't propagate forward.
 */
export class InlineApiKeyStore implements ApiKeyStore {
  private readonly profileId: string;
  private readonly entries: InlineApiKeyEntry[];
  /**
   * Per-instance HMAC secret. See class JSDoc for rationale: this is a
   * length-normalization device, not an authenticator. 32 bytes = 256 bits
   * of entropy is overkill for that purpose but matches HMAC-SHA256 block size.
   */
  private readonly hmacKey: Buffer;

  constructor(profileId: string, entries: InlineApiKeyEntry[]) {
    this.profileId = profileId;
    this.entries = entries;
    this.hmacKey = randomBytes(32);
  }

  private digest(value: string): Buffer {
    return createHmac('sha256', this.hmacKey).update(value, 'utf8').digest();
  }

  async validate(key: string): Promise<AuthorizedPrincipal | null> {
    const keyDigest = this.digest(key);
    for (const entry of this.entries) {
      const configured = process.env[entry.key_from_env];
      // Empty string and `undefined` both treated as "not configured" — this
      // matches operator intent (an env var explicitly set to "" is still a
      // misconfiguration) and avoids the surprise of validating against "".
      if (!configured) continue;
      // Both digests are always 32 bytes — `timingSafeEqual` is safe with no
      // padding and no length branch.
      if (timingSafeEqual(keyDigest, this.digest(configured))) {
        return {
          authType: 'token',
          profileId: this.profileId,
          subject: entry.subject,
          scopes: entry.scopes ?? [],
        };
      }
    }
    return null;
  }
}
