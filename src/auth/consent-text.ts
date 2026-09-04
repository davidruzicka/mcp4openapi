/**
 * Localized consent text resolution and canonicalization.
 *
 * Display and evidence are deliberately separated: `resolveConsentText` picks
 * the variant a page renders (negotiated locale -> `en` -> first key), while
 * `canonicalizeConsentText` feeds the WHOLE multilingual bundle into the rules
 * hash so a grant never depends on which language happened to be on screen.
 */

import type { LocalizedConsentText } from '../types/profile.js';

/** Locale fallback anchor: a localized map must always carry this key. */
export const CONSENT_FALLBACK_LOCALE = 'en';

/**
 * Pick the display variant for a locale. Fallback chain: exact locale ->
 * `en` -> lexicographically first key (defensive; validation requires `en`).
 */
export function resolveConsentText(
  value: LocalizedConsentText | undefined,
  locale: string,
): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  const fallbackKey = Object.keys(value).sort()[0];
  return value[locale] ?? value[CONSENT_FALLBACK_LOCALE] ?? (fallbackKey !== undefined ? value[fallbackKey] : undefined);
}

/** Canonical form of one consent text inside the hashed parts array. */
export type CanonicalConsentText = string | null | [string, string][];

/**
 * Canonical hash material for one consent text.
 *
 * Plain strings pass through UNCHANGED so every pre-i18n profile keeps its
 * exact rules hash and existing grants survive the upgrade. Maps become a
 * sorted `[locale, text]` entry ARRAY: inside the JSON-serialized parts a
 * nested array is structurally distinct from every string, so key order
 * cannot change the hash and no crafted string can collide with a map.
 */
export function canonicalizeConsentText(value: LocalizedConsentText | undefined): CanonicalConsentText {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
