import type { Logger } from '../core/logger.js';
import type { ConsentGateConfig } from '../types/profile.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import type { ConsentEvidenceStore } from './consent-evidence-store.js';
import { ConsentRequiredError } from '../core/errors.js';

/**
 * Consent gate enforcement.
 *
 * `assertConsent(principal)` is invoked before any upstream tool dispatch on a
 * consent-gated profile. When consent is required and the authenticated subject
 * has not recorded acceptance for the current `rules_version`, it throws
 * `ConsentRequiredError` carrying the `consent_url` the human must visit.
 *
 * The gate is intentionally NOT exposed as an MCP tool: an autonomous agent
 * must not be able to grant consent on the user's behalf. Consent is bound to a
 * provable human identity (`principal.subject`) established by the interactive
 * OAuth login that drives `ConsentEvidenceStore.record`.
 *
 * HTTP transport invokes this gate before upstream tool dispatch. Consent is
 * recorded only after explicit browser approval and cryptographically verified
 * profile-OAuth identity. Stdio cannot complete that browser flow and therefore
 * remains unavailable for required consent-gated upstream profiles.
 */
export class ConsentGate {
  constructor(
    private readonly profileId: string,
    private readonly config: ConsentGateConfig,
    private readonly store: ConsentEvidenceStore,
    /** Resolves the browser-facing consent URL for a profile (base URL is transport-owned). */
    private readonly consentUrlFor: (profileId: string) => string,
    private readonly logger: Logger,
  ) {}

  /**
   * Throw `ConsentRequiredError` when consent is required and not yet recorded.
   *
   * A missing principal (anonymous session) can never satisfy the gate, because
   * consent must be bound to a provable human subject — so it is treated as
   * "no consent" and blocked.
   */
  async assertConsent(principal: AuthorizedPrincipal | null): Promise<void> {
    if (!this.config.required) return;

    const subject = principal?.subject;
    if (subject) {
      const hasConsent = await this.store.has(
        subject,
        this.profileId,
        this.config.rules_version,
      );
      if (hasConsent) return;
    }

    this.logger.debug('Consent required: blocking tool dispatch', {
      profileId: this.profileId,
      rulesVersion: this.config.rules_version,
      hasSubject: Boolean(subject),
    });

    throw new ConsentRequiredError(
      `Consent required for profile '${this.profileId}' at rules_version '${this.config.rules_version}'`,
      {
        profileId: this.profileId,
        rules_version: this.config.rules_version,
        consent_url: this.consentUrlFor(this.profileId),
        education_resource: this.config.education_resource,
      },
    );
  }
}
