import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  decryptTokenPayload,
  deriveTokenKey,
  encryptTokenPayload,
  isEncryptedToken,
  type TokenEnvelopePayload,
} from './token-envelope.js';

const VALIDATE_TOKEN_REGEX = /^[A-Za-z0-9._~+/:=-]+$/;
const PREFIX = 'mcp4.v1.';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const KEY = createHash('sha256').update('test-passphrase').digest();
const OTHER_KEY = createHash('sha256').update('different-passphrase').digest();
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

  it('deriveTokenKey returns SHA-256(raw) 32-byte Buffer for non-hex strings and 63-char hex strings', () => {
    const passphrase = 'any-passphrase-not-hex';
    const k1 = deriveTokenKey(passphrase);
    expect(k1.length).toBe(32);
    expect(k1.equals(createHash('sha256').update(passphrase).digest())).toBe(true);

    // 63-char hex → falls into SHA-256 branch (length must be EXACTLY 64)
    const sixtyThreeHex = '0123456789abcdef'.repeat(3) + '0123456789abcde';
    expect(sixtyThreeHex.length).toBe(63);
    const k2 = deriveTokenKey(sixtyThreeHex);
    expect(k2.length).toBe(32);
    expect(k2.equals(createHash('sha256').update(sixtyThreeHex).digest())).toBe(true);
  });

  it('isEncryptedToken matches mcp4.v1. prefix only', () => {
    expect(isEncryptedToken('mcp4.v1.abc')).toBe(true);
    expect(isEncryptedToken('mcp4.v2.abc')).toBe(false);
    expect(isEncryptedToken('plain-token')).toBe(false);
    expect(isEncryptedToken('')).toBe(false);
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
});

// Touch unused imports so eslint never trips on tree-shaken helpers in test contexts.
void randomBytes;
void TAG_BYTES;
