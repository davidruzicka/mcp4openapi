import { describe, expect, it } from 'vitest';

import { normalizeIssuer } from './issuer.js';

describe('normalizeIssuer', () => {
  it('removes one trailing slash without changing issuer path components', () => {
    expect(normalizeIssuer('https://issuer.example.test/tenant/v2.0/')).toBe(
      'https://issuer.example.test/tenant/v2.0',
    );
  });

  it('leaves an issuer without a trailing slash unchanged', () => {
    expect(normalizeIssuer('https://issuer.example.test/tenant/v2.0')).toBe(
      'https://issuer.example.test/tenant/v2.0',
    );
  });
});
