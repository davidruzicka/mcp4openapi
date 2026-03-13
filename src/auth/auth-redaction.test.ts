import { describe, expect, it } from 'vitest';
import { redactAuthPayload, sanitizeAuthErrorMessage } from './auth-redaction.js';

describe('auth-redaction', () => {
  it('redacts nested auth payload fields', () => {
    const jwt = 'aaaaaaaaaaa.bbbbbbbbbbb.cccccccccccdddddddddddd';
    const redacted = redactAuthPayload({
      assertion: jwt,
      nested: {
        refresh_token: 'top-secret-value-top-secret',
      },
    });

    expect(redacted.assertion).toBe('[REDACTED_JWT]');
    expect(redacted.nested.refresh_token).toBe('[REDACTED_SECRET]');
  });

  it('preserves non-secret fields while redacting secret arrays and primitive values', () => {
    const payload = {
      authorization: [
        'short-secret',
        'header.payload.signaturewithmanychars',
        123,
      ],
      public_value: 'keep-me',
      nested: {
        access_token: null,
      },
    };

    const redacted = redactAuthPayload(payload);
    expect(redacted.authorization).toEqual(['[REDACTED]', '[REDACTED_JWT]', 123]);
    expect(redacted.public_value).toBe('keep-me');
    expect(redacted.nested.access_token).toBe('[REDACTED]');
  });

  it('returns primitive values unchanged when they are not forced into redaction', () => {
    expect(redactAuthPayload('visible-token')).toBe('visible-token');
    expect(redactAuthPayload(42)).toBe(42);
    expect(redactAuthPayload(null)).toBeNull();
  });

  it('sanitizes jwt-looking substrings from error messages', () => {
    expect(sanitizeAuthErrorMessage('bad token abc.def.ghi-jklmnopqrstuvwxyz')).toContain('[REDACTED_JWT]');
  });
});
