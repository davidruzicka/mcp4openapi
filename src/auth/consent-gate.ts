import type { Logger } from '../core/logger.js';
import type { ConsentGateConfig } from '../types/profile.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import type { ConsentEvidenceStore } from './consent-evidence-store.js';
import type { ConsentDenialReason } from '../core/errors.js';
import { ConsentRequiredError } from '../core/errors.js';
import { normalizeIssuer } from './issuer.js';
import { computeRulesHash } from './consent-rules-hash.js';

/**
 * Consent gate enforcement.
 *
 * `assertConsent(principal)` is invoked before any upstream tool dispatch on a
 * consent-gated profile. When consent is required and the authenticated subject
 * has not recorded acceptance for the current rules, it throws
 * `ConsentRequiredError` carrying the `consent_url` the human must visit.
 *
 * The gate is intentionally NOT exposed as an MCP tool: an autonomous agent
 * must not be able to grant consent on the user's behalf. Consent is bound to a
 * provable human identity (`principal.subject`) and its verified issuer/tenant
 * context, established by the interactive OAuth login that drives
 * `ConsentEvidenceStore.record`.
 *
 * All consent policy lives here, never in a store implementation: identity
 * source, issuer canonicalization, rules pinning, revocation, max age, and
 * rules-version rollback. A store only persists and returns records.
 *
 * There is no positive-result cache: every dispatch consults the store, so a
 * revocation takes effect immediately. Adding a cache would introduce
 * revocation latency and requires revisiting that decision.
 */
export class ConsentGate {
  private readonly expectedRulesHash: string;
  private readonly maxAgeMs: number | null;
  private readonly expectedIssuer: string | null;

  constructor(
    private readonly profileId: string,
    private readonly config: ConsentGateConfig,
    private readonly store: ConsentEvidenceStore,
    /** Resolves the browser-facing consent URL for a profile (base URL is transport-owned). */
    private readonly consentUrlFor: (profileId: string) => string,
    private readonly logger: Logger,
    /** Issuer of the profile OAuth provider; a principal from any other issuer is rejected. */
    expectedIssuer?: string,
  ) {
    this.expectedRulesHash = computeRulesHash(config);
    // Null check, not truthiness: max_age_days=0 must not silently mean
    // "never expires". Values <= 0 are rejected by the consent gate validator.
    this.maxAgeMs = config.max_age_days != null ? config.max_age_days * 24 * 60 * 60 * 1000 : null;
    this.expectedIssuer = expectedIssuer ? normalizeIssuer(expectedIssuer) : null;
  }

  /** Digest of the rules material a grant must carry to satisfy this gate. */
  get rulesHash(): string {
    return this.expectedRulesHash;
  }

  /**
   * Throw `ConsentRequiredError` when consent is required and not satisfied.
   *
   * A missing principal (anonymous session) can never satisfy the gate, because
   * consent must be bound to a provable human subject, so it is treated as
   * "no consent" and blocked.
   */
  async assertConsent(principal: AuthorizedPrincipal | null): Promise<void> {
    if (!this.config.required) return;

    const denial = await this.evaluate(principal);
    if (!denial) return;

    this.logger.debug('Consent required: blocking tool dispatch', {
      profileId: this.profileId,
      rulesVersion: this.config.rules_version,
      reason: denial,
      hasSubject: Boolean(principal?.subject),
      hasIssuer: Boolean(principal?.issuer),
      hasTenant: principal?.tenantId !== undefined,
    });

    throw new ConsentRequiredError(
      `Consent required for profile '${this.profileId}' at rules_version '${this.config.rules_version}'`,
      {
        profileId: this.profileId,
        rules_version: this.config.rules_version,
        consent_url: this.consentUrlFor(this.profileId),
        education_resource: this.config.education_resource,
      },
      denial,
    );
  }

  /** Returns the denial reason, or null when the principal may dispatch. */
  private async evaluate(principal: AuthorizedPrincipal | null): Promise<ConsentDenialReason | null> {
    if (!principal?.subject || !principal.issuer) return 'no_principal';
    // `identity_source: profile_oauth` means only a verified profile-OAuth login
    // counts. An enterprise or static-token principal carrying the same subject
    // and issuer must not satisfy the gate.
    if (principal.authType !== 'oauth') return 'auth_type_mismatch';

    const issuer = normalizeIssuer(principal.issuer);
    if (this.expectedIssuer && issuer !== this.expectedIssuer) return 'issuer_mismatch';

    const identity = {
      sub: principal.subject,
      issuer,
      tenantId: principal.tenantId ?? null,
    };
    const state = await this.store.lookup(identity, this.profileId, this.config.rules_version);

    if (!state.grant) return 'no_evidence';
    if (state.grant.rules_hash !== this.expectedRulesHash) return 'rules_changed';
    // A rules_version rollback (v2 back to v1) must not reactivate the older
    // grant: only the most recently accepted version counts.
    if (state.latestGrant && state.latestGrant.rules_version !== this.config.rules_version) {
      return 'rules_rollback';
    }
    // Policy uses the most recent acceptance (the grant a store returns always
    // carries it), so accepting again after a revocation or past the max age
    // works. Ordering the revocation against it by these caller-supplied
    // timestamps assumes reasonably synchronized writer clocks, which holds for
    // the single-node in-memory/file stores; the multi-replica Postgres store
    // orders this supersession by insertion order instead and shapes the
    // `revokedAt` it returns so this comparison reproduces that decision.
    const acceptedAt = state.grant.granted_at;
    if (state.revokedAt !== null && state.revokedAt >= acceptedAt) return 'revoked';
    if (this.maxAgeMs !== null && Date.now() - acceptedAt > this.maxAgeMs) return 'expired';

    return null;
  }
}
