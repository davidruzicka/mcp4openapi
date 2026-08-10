import { describe, expect, it } from 'vitest';
import { pseudonymizeSubject } from './observability-pseudonym.js';

const OIDC_SUBJECT = 'oidc-subject:https://issuer.example.test/00u123456789abcdefghijklmnop';

describe('pseudonymizeSubject', () => {
  it('returns the same pseudonym for the same subject', () => {
    expect(pseudonymizeSubject(OIDC_SUBJECT)).toBe(pseudonymizeSubject(OIDC_SUBJECT));
  });

  it('returns distinct pseudonyms for distinct subjects', () => {
    expect(pseudonymizeSubject(OIDC_SUBJECT)).not.toBe(
      pseudonymizeSubject('oidc-subject:https://issuer.example.test/00u987654321abcdefghijklmnop'),
    );
  });

  it('uses a fixed ASCII SHA-256 pseudonym format', () => {
    expect(pseudonymizeSubject(OIDC_SUBJECT)).toMatch(/^pseudonym-sha256-[a-f0-9]{32}$/);
  });

  it('does not include the raw subject in the pseudonym', () => {
    expect(pseudonymizeSubject(OIDC_SUBJECT)).not.toContain(OIDC_SUBJECT);
  });
});