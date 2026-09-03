/**
 * Rules pinning for consent evidence.
 *
 * `rules_version` alone does not identify what a subject accepted: the rendered
 * summary and the education link can change without a version bump. The hash
 * below pins exactly the rules material this gateway renders, so a grant
 * records what was on screen. The external `education_resource` document is NOT
 * pinned - the gateway cannot verify remote content, only the link it showed.
 *
 * SHA-256 is a content digest here, not a password KDF. The scrypt migration in
 * `token-envelope.ts` replaced SHA-256 only for passphrase derivation.
 */
import { createHash } from 'node:crypto';
import { canonicalizeConsentText, type CanonicalConsentText } from './consent-text.js';
import type { ConsentGateConfig } from '../types/profile.js';

export type ConsentRulesMaterial = Pick<
  ConsentGateConfig,
  'rules_version' | 'rules_summary' | 'education_resource' | 'labels'
>;

/**
 * Stable digest over the rules material presented to the human.
 *
 * The page template (`consent_gate.template`/`template_path`) is deliberately
 * NOT hashed: it is cosmetic (layout, CSS, surrounding copy) and may change
 * without forcing org-wide re-consent. The canonical record of what a subject
 * agreed to is this hashed material - version, summary, education link, and
 * the approval-form labels.
 */
export function computeRulesHash(material: ConsentRulesMaterial): string {
  // Localized maps canonicalize to sorted entry arrays (structurally distinct
  // from strings in the JSON serialization); plain strings pass through
  // unchanged so pre-i18n profiles keep their exact hash. The WHOLE
  // multilingual bundle is hashed - the grant does not depend on which
  // language the page rendered in, and editing any variant invalidates it.
  const parts: CanonicalConsentText[] = [
    material.rules_version,
    canonicalizeConsentText(material.rules_summary),
    canonicalizeConsentText(material.education_resource),
  ];
  // Appended only when labels are configured, so profiles without labels keep
  // their pre-labels hash and existing grants stay valid across the upgrade.
  if (material.labels && (material.labels.accept !== undefined || material.labels.submit !== undefined)) {
    parts.push(canonicalizeConsentText(material.labels.accept), canonicalizeConsentText(material.labels.submit));
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
}
