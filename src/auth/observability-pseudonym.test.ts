import { afterEach, describe, expect, it } from 'vitest';
import { configureObservabilityPseudonym, pseudonymizeSubject } from './observability-pseudonym.js';

const OIDC_SUBJECT = 'oidc-subject:https://issuer.example.test/00u123456789abcdefghijklmnop';

// Module-level key state must never leak between tests.
afterEach(() => configureObservabilityPseudonym(undefined));

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

describe('configureObservabilityPseudonym (keyed HMAC mode)', () => {
  it('keyed output differs from the unkeyed output but keeps the format', () => {
    const unkeyed = pseudonymizeSubject(OIDC_SUBJECT);
    configureObservabilityPseudonym('token-key-material');
    const keyed = pseudonymizeSubject(OIDC_SUBJECT);

    expect(keyed).not.toBe(unkeyed);
    expect(keyed).toMatch(/^pseudonym-sha256-[a-f0-9]{32}$/);
  });

  it('keyed mode stays deterministic for the same key and subject', () => {
    configureObservabilityPseudonym('token-key-material');
    expect(pseudonymizeSubject(OIDC_SUBJECT)).toBe(pseudonymizeSubject(OIDC_SUBJECT));
  });

  it('reconfiguration with a different key changes the output', () => {
    configureObservabilityPseudonym('key-one');
    const first = pseudonymizeSubject(OIDC_SUBJECT);
    configureObservabilityPseudonym('key-two');
    const second = pseudonymizeSubject(OIDC_SUBJECT);

    expect(first).not.toBe(second);
  });

  it('accepts Buffer key material (transport passes the raw tokenKey)', () => {
    configureObservabilityPseudonym('token-key-material');
    const fromString = pseudonymizeSubject(OIDC_SUBJECT);
    configureObservabilityPseudonym(Buffer.from('token-key-material', 'utf8'));
    const fromBuffer = pseudonymizeSubject(OIDC_SUBJECT);

    expect(fromBuffer).toBe(fromString);
  });

  it('configuring undefined restores the unkeyed behavior', () => {
    const unkeyed = pseudonymizeSubject(OIDC_SUBJECT);
    configureObservabilityPseudonym('token-key-material');
    expect(pseudonymizeSubject(OIDC_SUBJECT)).not.toBe(unkeyed);
    configureObservabilityPseudonym(undefined);
    expect(pseudonymizeSubject(OIDC_SUBJECT)).toBe(unkeyed);
  });
});
