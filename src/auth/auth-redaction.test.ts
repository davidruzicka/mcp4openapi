import { describe, expect, it, vi } from 'vitest';
import { redactAuthPayload, sanitizeAuthErrorMessage, redactString } from './auth-redaction.js';
import { ConsentGate } from './consent-gate.js';
import { InMemoryConsentEvidenceStore } from './consent-evidence-store.js';
import { ConsentRequiredError } from '../core/errors.js';
import type { AuthorizedPrincipal } from './inbound-auth-principal.js';
import type { Logger } from '../core/logger.js';
import type { ConsentGateConfig } from '../types/profile.js';

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

  describe('upstream credential field redaction', () => {
    it('redacts upstream_token field', () => {
      const redacted = redactAuthPayload({ upstream_token: 'my-secret-long-value-1234' });
      expect(redacted.upstream_token).toBe('[REDACTED_SECRET]');
    });

    it('redacts x_api_key field', () => {
      const redacted = redactAuthPayload({ x_api_key: 'my-secret-long-value-5678' });
      expect(redacted.x_api_key).toBe('[REDACTED_SECRET]');
    });

    it('redacts api_key field', () => {
      const redacted = redactAuthPayload({ api_key: 'long-api-key-value-here-yes' });
      expect(redacted.api_key).toBe('[REDACTED_SECRET]');
    });

    it('redacts upstream_credentials field', () => {
      const redacted = redactAuthPayload({ upstream_credentials: 'long-credential-string-here' });
      expect(redacted.upstream_credentials).toBe('[REDACTED_SECRET]');
    });
  });

  describe('sanitizeAuthErrorMessage with Bearer patterns', () => {
    it('redacts long Bearer token values', () => {
      const msg = 'failed with Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9xxxx';
      const sanitized = sanitizeAuthErrorMessage(msg);
      expect(sanitized).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9xxxx');
    });

    it('preserves short non-secret text after Bearer', () => {
      const msg = 'Bearer token required';
      const sanitized = sanitizeAuthErrorMessage(msg);
      expect(sanitized).toBe('Bearer token required');
    });
  });

  describe('sanitizeAuthErrorMessage Bearer suffix preservation (UAT Gap 2)', () => {
    it('preserves last 4 chars of long Bearer token as diagnostic suffix', () => {
      const result = sanitizeAuthErrorMessage('token Bearer ghp_abcdefghij1234567890');
      expect(result).toBe('token Bearer [REDACTED]...7890');
    });

    it('produces REDACTED...suffix pattern for any long Bearer token', () => {
      const result = sanitizeAuthErrorMessage('failed with Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig');
      // JWT regex fires first, so the Bearer token (which is a JWT) gets replaced by [REDACTED_JWT]
      // Bearer regex does NOT run on the JWT-replaced text in this case
      expect(result).toContain('[REDACTED_JWT]');
      expect(result).not.toContain('eyJ');
    });

    it('does NOT redact short Bearer values (token < 20 chars)', () => {
      const result = sanitizeAuthErrorMessage('short Bearer abc');
      expect(result).toBe('short Bearer abc');
    });

    it('returns unchanged string when no Bearer present', () => {
      const result = sanitizeAuthErrorMessage('no bearer here');
      expect(result).toBe('no bearer here');
    });

    it('case-insensitive Bearer matching', () => {
      const result = sanitizeAuthErrorMessage('auth: bearer abcdefghij1234567890xx');
      expect(result).toBe('auth: bearer [REDACTED]...90xx');
    });
  });

  describe('consent gate logging never emits raw identity values', () => {
    const IDENTITY_SENTINELS = {
      subject: 'SUBJECT-SENTINEL-9f3a2c',
      issuer: 'https://ISSUER-SENTINEL-9f3a2c.example.test/tenant/v2.0',
      tenantId: 'TENANT-SENTINEL-9f3a2c',
      nonce: 'NONCE-SENTINEL-9f3a2c',
      audience: 'AUDIENCE-SENTINEL-9f3a2c',
    };

    it('logs only booleans plus a reason when a real ConsentGate denies dispatch', async () => {
      const calls: unknown[][] = [];
      const capture = (...args: unknown[]): void => {
        calls.push(args);
      };
      const logger = {
        debug: vi.fn(capture),
        info: vi.fn(capture),
        warn: vi.fn(capture),
        error: vi.fn(capture),
      } as unknown as Logger;

      const config: ConsentGateConfig = {
        required: true,
        rules_version: 'v1',
        identity_source: 'profile_oauth',
      };
      const gate = new ConsentGate(
        'ms365',
        config,
        new InMemoryConsentEvidenceStore(),
        (profileId) => `https://mcp.example.test/consent/${profileId}`,
        logger,
        IDENTITY_SENTINELS.issuer,
      );

      // nonce/audience are not part of AuthorizedPrincipal; they are attached
      // here to prove the gate never spreads an incoming principal into a log.
      const principal = {
        authType: 'oauth',
        profileId: 'ms365',
        subject: IDENTITY_SENTINELS.subject,
        issuer: IDENTITY_SENTINELS.issuer,
        tenantId: IDENTITY_SENTINELS.tenantId,
        scopes: [],
        nonce: IDENTITY_SENTINELS.nonce,
        audience: IDENTITY_SENTINELS.audience,
      } as AuthorizedPrincipal & { nonce: string; audience: string };

      await expect(gate.assertConsent(principal)).rejects.toBeInstanceOf(ConsentRequiredError);

      const serialized = JSON.stringify(calls);
      expect(serialized).toContain('no_evidence');
      for (const [field, value] of Object.entries(IDENTITY_SENTINELS)) {
        expect(serialized, `raw ${field} leaked into consent logging`).not.toContain(value);
      }
      // The sentinel host alone must not leak either, even without the full URL.
      expect(serialized).not.toContain('ISSUER-SENTINEL-9f3a2c');
    });
  });

  describe('redactString - no suffix leakage in structured field redaction', () => {
    it('fully redacts long non-JWT values (no suffix)', () => {
      expect(redactString('long-secret-value-xyz')).toBe('[REDACTED_SECRET]');
    });

    it('fully redacts JWT-looking values (no suffix)', () => {
      expect(redactString('aaaaa.bbbbb.ccccccccccccccc')).toBe('[REDACTED_JWT]');
    });

    it('redacts short values too', () => {
      expect(redactString('short')).toBe('[REDACTED]');
    });
  });
});
