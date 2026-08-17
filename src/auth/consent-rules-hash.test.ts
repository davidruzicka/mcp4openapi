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

  it('ignores the page template (cosmetic changes never force re-consent)', () => {
    const withTemplate = computeRulesHash({
      ...base,
      template: '<html><body><style>body{color:red}</style>{{consent_body}}</body></html>',
      template_path: './consent.html',
    });
    expect(withTemplate).toBe(computeRulesHash(base));
  });
});
