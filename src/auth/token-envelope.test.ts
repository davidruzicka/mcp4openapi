import { describe, expect, it } from 'vitest';
import { createCipheriv as nodeCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { ValidationError } from '../core/errors.js';
import {
  decryptRefreshEnvelope,
  decryptTokenPayload,
  deriveLegacySha256TokenKey,
  deriveTokenKey,
  encryptRefreshEnvelope,
  encryptTokenPayload,
  isEncryptedToken,
  isRefreshEnvelope,
  type TokenEnvelopePayload,
} from './token-envelope.js';

const VALIDATE_TOKEN_REGEX = /^[A-Za-z0-9._~+/:=-]+$/;
const PREFIX = 'mcp4.v1.';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const KEY = deriveTokenKey('test-passphrase');
const OTHER_KEY = deriveTokenKey('different-passphrase');
const PROFILE_ID = 'test-profile';

const FULL_PAYLOAD: TokenEnvelopePayload = Object.freeze({
  v: 1,
  at: 'access-token-abc',
  rt: 'refresh-token-xyz',
  exp: 1700000000000,
  cid: 'client-1',
  sc: ['openid', 'email'],
  pid: PROFILE_ID,
  iat: 1699999000000,
  creg: Object.freeze({
    id: 'client-1',
    ru: ['https://example.test/cb'],
    gt: ['authorization_code', 'refresh_token'],
    rt_: ['code'],
    sc: 'openid email',
  }),
}) as TokenEnvelopePayload;

const MINIMAL_PAYLOAD: TokenEnvelopePayload = Object.freeze({
  v: 1,
  at: 'access-token-min',
  pid: PROFILE_ID,
  iat: 1699999000000,
}) as TokenEnvelopePayload;

function flipByte(token: string, byteOffsetFromSuffixStart: number): string {
  const suffix = token.slice(PREFIX.length);
  const bytes = Buffer.from(suffix, 'base64url');
  bytes[byteOffsetFromSuffixStart] ^= 0x01;
  return PREFIX + bytes.toString('base64url');
}

describe('token-envelope', () => {
  it('deriveTokenKey returns hex-decoded 32-byte Buffer for exactly-64-char hex string', () => {
    const rawHex = '0123456789abcdef'.repeat(4); // 64 hex chars
    const key = deriveTokenKey(rawHex);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    expect(key.equals(Buffer.from(rawHex, 'hex'))).toBe(true);
  });

  it('deriveTokenKey returns scrypt(raw) 32-byte Buffer for non-hex strings and 63-char hex strings', () => {
    const passphrase = 'any-passphrase-not-hex';
    const k1 = deriveTokenKey(passphrase);
    expect(k1.length).toBe(32);
    expect(k1.equals(scryptSync(passphrase, 'mcp4openapi:token-envelope:v1', 32))).toBe(true);

    // 63-char hex → falls into scrypt branch (length must be EXACTLY 64)
    const sixtyThreeHex = '0123456789abcdef'.repeat(3) + '0123456789abcde';
    expect(sixtyThreeHex.length).toBe(63);
    const k2 = deriveTokenKey(sixtyThreeHex);
    expect(k2.length).toBe(32);
    expect(k2.equals(scryptSync(sixtyThreeHex, 'mcp4openapi:token-envelope:v1', 32))).toBe(true);
  });

  it('isEncryptedToken matches mcp4.v1. prefix only', () => {
    expect(isEncryptedToken('mcp4.v1.abc')).toBe(true);
    expect(isEncryptedToken('mcp4.v2.abc')).toBe(false);
    expect(isEncryptedToken('plain-token')).toBe(false);
    expect(isEncryptedToken('')).toBe(false);
  });

  it('decrypts a legacy SHA-256 envelope via fallbackKey (backward compatibility)', () => {
    const legacyKey = deriveLegacySha256TokenKey('test-passphrase');
    const legacyToken = encryptTokenPayload(FULL_PAYLOAD, legacyKey);
    // Primary scrypt key alone cannot open the legacy envelope
    expect(decryptTokenPayload(legacyToken, KEY, PROFILE_ID)).toBeNull();
    // With the legacy fallback key it decrypts
    const out = decryptTokenPayload(legacyToken, KEY, PROFILE_ID, legacyKey);
    expect(out).not.toBeNull();
    expect(out).toEqual(FULL_PAYLOAD);
  });

  it('does not use fallbackKey when the primary key already succeeds', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    const wrongFallback = deriveLegacySha256TokenKey('unrelated');
    const out = decryptTokenPayload(token, KEY, PROFILE_ID, wrongFallback);
    expect(out).toEqual(FULL_PAYLOAD);
  });

  it('returns null when both primary and fallback keys fail', () => {
    const legacyToken = encryptTokenPayload(FULL_PAYLOAD, deriveLegacySha256TokenKey('other'));
    expect(decryptTokenPayload(legacyToken, KEY, PROFILE_ID, OTHER_KEY)).toBeNull();
  });

  it('deriveLegacySha256TokenKey matches SHA-256(raw)', () => {
    const key = deriveLegacySha256TokenKey('test-passphrase');
    expect(key.length).toBe(32);
    expect(key.equals(createHash('sha256').update('test-passphrase').digest())).toBe(true);
  });

  it('round-trips a full payload preserving every field', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    const out = decryptTokenPayload(token, KEY, PROFILE_ID);
    expect(out).not.toBeNull();
    expect(out).toEqual(FULL_PAYLOAD);
  });

  it('round-trips a minimal payload with optional fields absent on decrypted output', () => {
    const token = encryptTokenPayload(MINIMAL_PAYLOAD, KEY);
    const out = decryptTokenPayload(token, KEY, PROFILE_ID);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.v).toBe(1);
    expect(out.at).toBe('access-token-min');
    expect(out.pid).toBe(PROFILE_ID);
    expect(out.iat).toBe(1699999000000);
    expect(out.rt).toBeUndefined();
    expect(out.exp).toBeUndefined();
    expect(out.cid).toBeUndefined();
    expect(out.sc).toBeUndefined();
    expect(out.creg).toBeUndefined();
  });

  it.each([
    { sub: 'subject-1', iss: undefined },
    { sub: undefined, iss: 'https://issuer.example.test/tenant/v2.0' },
    { sub: '', iss: 'https://issuer.example.test/tenant/v2.0' },
    { sub: 'subject-1', iss: '' },
    { sub: 'subject-1', iss: 'https://issuer.example.test/tenant/v2.0', tid: 42 },
  ])('returns null for incoherent identity fields: $sub/$iss/$tid', (identity) => {
    const payload = {
      ...MINIMAL_PAYLOAD,
      ...identity,
    } as unknown as TokenEnvelopePayload;
    const token = encryptTokenPayload(payload, KEY);

    expect(decryptTokenPayload(token, KEY, PROFILE_ID)).toBeNull();
  });

  it('canonicalizes a trailing slash on a complete recovered issuer', () => {
    const token = encryptTokenPayload({
      ...MINIMAL_PAYLOAD,
      sub: 'subject-1',
      iss: 'https://issuer.example.test/tenant/v2.0/',
      tid: 'tenant-1',
    }, KEY);

    expect(decryptTokenPayload(token, KEY, PROFILE_ID)).toMatchObject({
      sub: 'subject-1',
      iss: 'https://issuer.example.test/tenant/v2.0',
      tid: 'tenant-1',
    });
  });

  it('returns null when decrypting with the wrong key (no throw)', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    let result: TokenEnvelopePayload | null = FULL_PAYLOAD;
    expect(() => {
      result = decryptTokenPayload(token, OTHER_KEY, PROFILE_ID);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('returns null when a ciphertext byte is tampered', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    // Past the 12-byte nonce, before the 16-byte tag
    const tampered = flipByte(token, NONCE_BYTES + 5);
    expect(decryptTokenPayload(tampered, KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null when an auth-tag byte is tampered', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    const suffix = token.slice(PREFIX.length);
    const decodedLength = Buffer.from(suffix, 'base64url').length;
    // Within the last 16 bytes (the auth tag)
    const tampered = flipByte(token, decodedLength - 5);
    expect(decryptTokenPayload(tampered, KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null on AAD/profile mismatch (cross-profile replay)', () => {
    const payload: TokenEnvelopePayload = { ...FULL_PAYLOAD, pid: 'profile-a' };
    const token = encryptTokenPayload(payload, KEY);
    expect(decryptTokenPayload(token, KEY, 'profile-b')).toBeNull();
  });

  it('returns null for plain tokens missing the mcp4.v1. prefix', () => {
    expect(decryptTokenPayload('plain-token', KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null for truncated tokens (less than nonce+tag bytes)', () => {
    const tooShort = PREFIX + Buffer.alloc(20).toString('base64url');
    expect(decryptTokenPayload(tooShort, KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null for invalid base64url after the prefix', () => {
    expect(decryptTokenPayload('mcp4.v1.!!!not-base64!!!', KEY, PROFILE_ID)).toBeNull();
  });

  it('produces distinct ciphertexts for the same payload (nonce randomness) and at least one round-trips', () => {
    const tokens = Array.from({ length: 100 }, () => encryptTokenPayload(FULL_PAYLOAD, KEY));
    expect(new Set(tokens).size).toBe(100);
    const sample = decryptTokenPayload(tokens[0]!, KEY, PROFILE_ID);
    expect(sample).not.toBeNull();
    expect(sample).toEqual(FULL_PAYLOAD);
  });

  it('encrypt output matches the validateToken regex used by http-transport', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    expect(token).toMatch(VALIDATE_TOKEN_REGEX);
  });

  it('returns null for null/undefined/empty/prefix-only/garbage inputs and never throws', () => {
    expect(() =>
      decryptTokenPayload(null as unknown as string, KEY, PROFILE_ID),
    ).not.toThrow();
    expect(decryptTokenPayload(null as unknown as string, KEY, PROFILE_ID)).toBeNull();

    expect(() =>
      decryptTokenPayload(undefined as unknown as string, KEY, PROFILE_ID),
    ).not.toThrow();
    expect(decryptTokenPayload(undefined as unknown as string, KEY, PROFILE_ID)).toBeNull();

    expect(() => decryptTokenPayload('', KEY, PROFILE_ID)).not.toThrow();
    expect(decryptTokenPayload('', KEY, PROFILE_ID)).toBeNull();

    expect(() => decryptTokenPayload('mcp4.v1.', KEY, PROFILE_ID)).not.toThrow();
    expect(decryptTokenPayload('mcp4.v1.', KEY, PROFILE_ID)).toBeNull();

    const objectAsString = { foo: 'bar' } as unknown as string;
    expect(() => decryptTokenPayload(objectAsString, KEY, PROFILE_ID)).not.toThrow();
    expect(decryptTokenPayload(objectAsString, KEY, PROFILE_ID)).toBeNull();
  });

  it('round-trips creg with all subfields byte-equal', () => {
    const payload: TokenEnvelopePayload = {
      v: 1,
      at: 'at-creg',
      pid: PROFILE_ID,
      iat: 1699999000001,
      creg: {
        id: 'c1',
        ru: ['https://a/cb'],
        gt: ['authorization_code', 'refresh_token'],
        rt_: ['code'],
        sc: 'openid email',
      },
    };
    const token = encryptTokenPayload(payload, KEY);
    const out = decryptTokenPayload(token, KEY, PROFILE_ID);
    expect(out).not.toBeNull();
    expect(out?.creg).toEqual(payload.creg);
    expect(out?.creg?.id).toBe('c1');
    expect(out?.creg?.ru).toEqual(['https://a/cb']);
    expect(out?.creg?.gt).toEqual(['authorization_code', 'refresh_token']);
    expect(out?.creg?.rt_).toEqual(['code']);
    expect(out?.creg?.sc).toBe('openid email');
  });

  it('round-trips without creg leaving envelope.creg undefined (not empty object)', () => {
    const payload: TokenEnvelopePayload = {
      v: 1,
      at: 'at-no-creg',
      pid: PROFILE_ID,
      iat: 1699999000002,
    };
    const token = encryptTokenPayload(payload, KEY);
    const out = decryptTokenPayload(token, KEY, PROFILE_ID);
    expect(out).not.toBeNull();
    expect(out?.creg).toBeUndefined();
    expect('creg' in (out as object)).toBe(false);
  });

  it('encryptTokenPayload throws ValidationError on empty pid', () => {
    expect(() =>
      encryptTokenPayload({ ...FULL_PAYLOAD, pid: '' }, KEY),
    ).toThrow(ValidationError);
  });

  it('encryptTokenPayload throws ValidationError when key is wrong length (31 bytes)', () => {
    const shortKey = randomBytes(31);
    expect(() =>
      encryptTokenPayload(FULL_PAYLOAD, shortKey),
    ).toThrow(ValidationError);
  });

  it('decryptTokenPayload returns null for 31-byte (wrong-length) key without throwing', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    const shortKey = randomBytes(31);
    let result: TokenEnvelopePayload | null = FULL_PAYLOAD;
    expect(() => {
      result = decryptTokenPayload(token, shortKey, PROFILE_ID);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('decryptTokenPayload returns null for empty profileId without throwing', () => {
    const token = encryptTokenPayload(FULL_PAYLOAD, KEY);
    let result: TokenEnvelopePayload | null = FULL_PAYLOAD;
    expect(() => {
      result = decryptTokenPayload(token, KEY, '');
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('decryptTokenPayload returns null when at field is empty string', () => {
    // Craft raw ciphertext with at='' since encryptTokenPayload does not validate at
    const nonce = randomBytes(12);
    const cipher = nodeCipheriv('aes-256-gcm', KEY, nonce);
    cipher.setAAD(Buffer.from(PROFILE_ID, 'utf8'));
    const plain = Buffer.from(JSON.stringify({ ...FULL_PAYLOAD, at: '' }), 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const token = 'mcp4.v1.' + Buffer.concat([nonce, ct, tag]).toString('base64url');
    expect(decryptTokenPayload(token, KEY, PROFILE_ID)).toBeNull();
  });

  it('decryptTokenPayload returns null when v !== 1', () => {
    const nonce = randomBytes(12);
    const cipher = nodeCipheriv('aes-256-gcm', KEY, nonce);
    cipher.setAAD(Buffer.from(PROFILE_ID, 'utf8'));
    const plain = Buffer.from(JSON.stringify({ ...FULL_PAYLOAD, v: 2 }), 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const token = 'mcp4.v1.' + Buffer.concat([nonce, ct, tag]).toString('base64url');
    expect(decryptTokenPayload(token, KEY, PROFILE_ID)).toBeNull();
  });

  it('decryptTokenPayload returns null when iat is a string (non-number)', () => {
    const nonce = randomBytes(12);
    const cipher = nodeCipheriv('aes-256-gcm', KEY, nonce);
    cipher.setAAD(Buffer.from(PROFILE_ID, 'utf8'));
    const plain = Buffer.from(JSON.stringify({ ...FULL_PAYLOAD, iat: 'not-a-number' }), 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const token = 'mcp4.v1.' + Buffer.concat([nonce, ct, tag]).toString('base64url');
    expect(decryptTokenPayload(token, KEY, PROFILE_ID)).toBeNull();
  });
});

// Touch unused imports so eslint never trips on tree-shaken helpers in test contexts.
void TAG_BYTES;

describe('refresh envelope', () => {
  const payload = {
    v: 1 as const,
    rt: 'idp-refresh-token',
    cid: 'client-1',
    sub: 'person-1',
    iss: 'https://issuer.example.test/v2.0',
    tid: 'tenant-1',
    pid: PROFILE_ID,
    iat: Date.now(),
  };

  it('round-trips the identity bound to the refresh token', () => {
    const envelope = encryptRefreshEnvelope(payload, KEY);
    expect(isRefreshEnvelope(envelope)).toBe(true);
    expect(decryptRefreshEnvelope(envelope, KEY, PROFILE_ID)).toMatchObject({
      rt: 'idp-refresh-token',
      sub: 'person-1',
      tid: 'tenant-1',
    });
  });

  it('rejects a refresh envelope presented for another profile', () => {
    const envelope = encryptRefreshEnvelope(payload, KEY);
    expect(decryptRefreshEnvelope(envelope, KEY, 'other-profile')).toBeNull();
  });

  it('rejects a refresh envelope decrypted with the wrong key', () => {
    const envelope = encryptRefreshEnvelope(payload, KEY);
    expect(decryptRefreshEnvelope(envelope, OTHER_KEY, PROFILE_ID)).toBeNull();
  });

  it('cannot be presented as an access token envelope', () => {
    const envelope = encryptRefreshEnvelope(payload, KEY);
    expect(isEncryptedToken(envelope)).toBe(false);
    expect(decryptTokenPayload(envelope, KEY, PROFILE_ID)).toBeNull();
  });

  it('does not accept an access token envelope as a refresh envelope', () => {
    const accessEnvelope = encryptTokenPayload(
      { v: 1, at: 'access', rt: 'refresh', pid: PROFILE_ID, iat: Date.now() },
      KEY,
    );
    expect(isRefreshEnvelope(accessEnvelope)).toBe(false);
    expect(decryptRefreshEnvelope(accessEnvelope, KEY, PROFILE_ID)).toBeNull();
  });

  it('rejects an envelope carrying a subject without an issuer', () => {
    const envelope = encryptRefreshEnvelope({ ...payload, iss: undefined }, KEY);
    expect(decryptRefreshEnvelope(envelope, KEY, PROFILE_ID)).toBeNull();
  });

  it('omits identity when the grant had none', () => {
    const envelope = encryptRefreshEnvelope(
      { v: 1, rt: 'r', cid: 'c', pid: PROFILE_ID, iat: Date.now() },
      KEY,
    );
    const decrypted = decryptRefreshEnvelope(envelope, KEY, PROFILE_ID);
    expect(decrypted?.sub).toBeUndefined();
    expect(decrypted?.rt).toBe('r');
  });

  it('throws when the refresh token or profile is missing', () => {
    expect(() => encryptRefreshEnvelope({ ...payload, rt: '' }, KEY)).toThrow(ValidationError);
    expect(() => encryptRefreshEnvelope({ ...payload, pid: '' }, KEY)).toThrow(ValidationError);
  });
});

describe('refresh envelope decoder guards', () => {
  const REFRESH_PAYLOAD = {
    v: 1,
    rt: 'idp-refresh',
    cid: 'client-1',
    sub: 'person-1',
    iss: 'https://issuer.example.test/v2.0',
    tid: 'tenant-1',
    pid: PROFILE_ID,
    iat: Date.now(),
  };

  /** Craft a refresh envelope directly, bypassing encryptRefreshEnvelope validation. */
  const craftRefresh = (payload: unknown, key: Buffer = KEY, aadProfile = PROFILE_ID): string => {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = nodeCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${aadProfile}:refresh`, 'utf8'));
    const plain = Buffer.from(JSON.stringify(payload), 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'mcp4.r1.' + Buffer.concat([nonce, ct, tag]).toString('base64url');
  };

  it('retries with the legacy fallback key', () => {
    // Passphrase deployments predating the scrypt KDF must keep working.
    const legacyKey = deriveLegacySha256TokenKey('test-passphrase');
    const envelope = craftRefresh(REFRESH_PAYLOAD, legacyKey);

    expect(decryptRefreshEnvelope(envelope, KEY, PROFILE_ID)).toBeNull();
    expect(decryptRefreshEnvelope(envelope, KEY, PROFILE_ID, legacyKey)).toMatchObject({
      rt: 'idp-refresh',
      sub: 'person-1',
    });
  });

  it('returns null for a key of the wrong length', () => {
    const envelope = encryptRefreshEnvelope(REFRESH_PAYLOAD, KEY);
    expect(decryptRefreshEnvelope(envelope, Buffer.alloc(16, 1), PROFILE_ID)).toBeNull();
  });

  it('returns null for a blank profile id', () => {
    const envelope = encryptRefreshEnvelope(REFRESH_PAYLOAD, KEY);
    expect(decryptRefreshEnvelope(envelope, KEY, '')).toBeNull();
  });

  it('returns null for a non-string token', () => {
    expect(decryptRefreshEnvelope(undefined as unknown as string, KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null when the plaintext is not a JSON object', () => {
    expect(decryptRefreshEnvelope(craftRefresh(['not', 'an', 'object']), KEY, PROFILE_ID)).toBeNull();
    expect(decryptRefreshEnvelope(craftRefresh('a string'), KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null for an unexpected version', () => {
    expect(decryptRefreshEnvelope(craftRefresh({ ...REFRESH_PAYLOAD, v: 2 }), KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null when required fields are missing or malformed', () => {
    const cases: Record<string, unknown>[] = [
      { ...REFRESH_PAYLOAD, rt: '' },
      { ...REFRESH_PAYLOAD, cid: '' },
      { ...REFRESH_PAYLOAD, iat: 'not-a-number' },
      // Identity must be all-or-nothing: a subject with no issuer cannot be bound.
      { ...REFRESH_PAYLOAD, iss: undefined },
      { ...REFRESH_PAYLOAD, sub: '' },
      { ...REFRESH_PAYLOAD, iss: '' },
      { ...REFRESH_PAYLOAD, tid: 42 },
      { ...REFRESH_PAYLOAD, tid: '' },
    ];

    for (const payload of cases) {
      expect(decryptRefreshEnvelope(craftRefresh(payload), KEY, PROFILE_ID)).toBeNull();
    }
  });

  it('returns null when the profile in the payload does not match the AAD profile', () => {
    // AAD binds the envelope to a profile; a mismatching pid is rejected too.
    const envelope = craftRefresh({ ...REFRESH_PAYLOAD, pid: 'other-profile' });
    expect(decryptRefreshEnvelope(envelope, KEY, PROFILE_ID)).toBeNull();
  });
});

describe('refresh envelope truncation guards', () => {
  it('returns null for a truncated refresh envelope', () => {
    // Shorter than nonce + tag + one byte of ciphertext: reject instead of
    // attempting to slice past the buffer.
    const truncated = 'mcp4.r1.' + randomBytes(NONCE_BYTES + TAG_BYTES - 1).toString('base64url');
    expect(decryptRefreshEnvelope(truncated, KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null for a refresh envelope whose body is not valid base64url', () => {
    expect(decryptRefreshEnvelope('mcp4.r1.not*base64url', KEY, PROFILE_ID)).toBeNull();
  });

  it('returns null for a refresh envelope with an empty body', () => {
    expect(decryptRefreshEnvelope('mcp4.r1.', KEY, PROFILE_ID)).toBeNull();
  });
});
