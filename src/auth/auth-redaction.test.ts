import { describe, expect, it } from 'vitest';
import { redactAuthPayload, sanitizeAuthErrorMessage } from './auth-redaction.js';

describe('auth-redaction', () => {
  it('redacts nested auth payload fields', () => {
    const redacted = redactAuthPayload({ assertion: 'abc.def.ghi', nested: { refresh_token: 'top-secret' } });
    expect(redacted.assertion).toBe('[REDACTED]');
    expect(redacted.nested.refresh_token).toBe('[REDACTED]');
  });

  it('sanitizes jwt-looking substrings from error messages', () => {
    expect(sanitizeAuthErrorMessage('bad token abc.def.ghi')).toContain('[REDACTED_JWT]');
  });
});
