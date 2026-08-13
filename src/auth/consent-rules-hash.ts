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
import type { ConsentGateConfig } from '../types/profile.js';

export type ConsentRulesMaterial = Pick<
  ConsentGateConfig,
  'rules_version' | 'rules_summary' | 'education_resource'
>;

/** Stable digest over the rules material presented to the human. */
export function computeRulesHash(material: ConsentRulesMaterial): string {
  const canonical = JSON.stringify([
    material.rules_version,
    material.rules_summary ?? null,
    material.education_resource ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('base64url');
}
