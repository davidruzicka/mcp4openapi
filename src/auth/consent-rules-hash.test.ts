import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeRulesHash } from './consent-rules-hash.js';
import type { ConsentGateConfig } from '../types/profile.js';

const base: ConsentGateConfig = {
  required: true,
  rules_version: 'v1',
  rules_summary: 'Accept the rules.',
  education_resource: 'https://kb.example.test/rules',
  identity_source: 'profile_oauth',
};

describe('computeRulesHash', () => {
  it('keeps the pre-labels hash for profiles without labels (upgrade keeps existing grants valid)', () => {
    const legacy = createHash('sha256')
      .update(JSON.stringify(['v1', 'Accept the rules.', 'https://kb.example.test/rules']))
      .digest('base64url');
    expect(computeRulesHash(base)).toBe(legacy);
  });

  it('changes when a label changes (labels are consent-meaningful)', () => {
    const withLabels = computeRulesHash({ ...base, labels: { accept: 'Souhlasím' } });
    expect(withLabels).not.toBe(computeRulesHash(base));
    expect(computeRulesHash({ ...base, labels: { accept: 'Souhlasím jinak' } })).not.toBe(withLabels);
    expect(computeRulesHash({ ...base, labels: { accept: 'Souhlasím', submit: 'Potvrdit' } })).not.toBe(withLabels);
  });

  it('hashes localized maps independently of key insertion order', () => {
    const csFirst = computeRulesHash({ ...base, rules_summary: { cs: 'Přijměte pravidla.', en: 'Accept the rules.' } });
    const enFirst = computeRulesHash({ ...base, rules_summary: { en: 'Accept the rules.', cs: 'Přijměte pravidla.' } });
    expect(csFirst).toBe(enFirst);
  });

  it('changes when any language variant changes (the whole bundle is consent-meaningful)', () => {
    const bundle = { en: 'Accept the rules.', cs: 'Přijměte pravidla.' };
    const original = computeRulesHash({ ...base, rules_summary: bundle });
    expect(computeRulesHash({ ...base, rules_summary: { ...bundle, cs: 'Přijměte nová pravidla.' } })).not.toBe(original);
    expect(computeRulesHash({ ...base, rules_summary: { ...bundle, de: 'Regeln akzeptieren.' } })).not.toBe(original);
  });

  it('never collides a localized map with an equal-looking plain string', () => {
    const asMap = computeRulesHash({ ...base, rules_summary: { en: 'Accept the rules.' } });
    expect(asMap).not.toBe(computeRulesHash(base));
    // A string spelling out the map's own serialization must still differ.
    expect(asMap).not.toBe(computeRulesHash({ ...base, rules_summary: '[["en","Accept the rules."]]' }));
  });

  it('localizes labels and education_resource into the hash too', () => {
    const localized = computeRulesHash({
      ...base,
      education_resource: { en: 'https://kb.example.test/rules', cs: 'https://kb.example.test/cs/rules' },
      labels: { accept: { en: 'I accept', cs: 'Souhlasím' } },
    });
    expect(localized).not.toBe(computeRulesHash(base));
    expect(computeRulesHash({
      ...base,
      education_resource: { en: 'https://kb.example.test/rules', cs: 'https://kb.example.test/cs/rules' },
      labels: { accept: { en: 'I accept', cs: 'Souhlasím JINAK' } },
    })).not.toBe(localized);
  });

  it('ignores the page template (cosmetic changes never force re-consent)', () => {
    const withTemplate = computeRulesHash({
      ...base,
      template: '<html><body><style>body{color:red}</style>{{consent_body}}</body></html>',
      template_path: './consent.html',
    });
    expect(withTemplate).toBe(computeRulesHash(base));
  });
});
