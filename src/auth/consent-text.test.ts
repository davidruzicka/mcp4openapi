import { describe, expect, it } from 'vitest';
import { canonicalizeConsentText, resolveConsentText } from './consent-text.js';

describe('resolveConsentText', () => {
  it('passes plain strings and undefined through', () => {
    expect(resolveConsentText('text', 'cs')).toBe('text');
    expect(resolveConsentText(undefined, 'cs')).toBeUndefined();
  });

  it('picks the exact locale, then en, then the first key', () => {
    const bundle = { en: 'english', cs: 'czech' };
    expect(resolveConsentText(bundle, 'cs')).toBe('czech');
    expect(resolveConsentText(bundle, 'de')).toBe('english');
    expect(resolveConsentText({ sk: 'slovak' }, 'de')).toBe('slovak');
  });
});

describe('canonicalizeConsentText', () => {
  it('keeps plain strings byte-identical (pre-i18n hashes must not move)', () => {
    expect(canonicalizeConsentText('Accept the rules.')).toBe('Accept the rules.');
    expect(canonicalizeConsentText(undefined)).toBeNull();
  });

  it('canonicalizes maps to sorted entry arrays', () => {
    expect(canonicalizeConsentText({ en: 'a', cs: 'b' })).toEqual([['cs', 'b'], ['en', 'a']]);
    expect(canonicalizeConsentText({ cs: 'b', en: 'a' })).toEqual([['cs', 'b'], ['en', 'a']]);
  });
});
