/**
 * Encrypted token envelope (AES-256-GCM) for restart-resilient OAuth sessions.
 *
 * Format: `mcp4.v1.<base64url(12-byte-nonce + ciphertext + 16-byte-tag)>`
 * AAD: profile_id as utf-8 bytes - binds token to profile, prevents cross-profile replay.
 *
 * Pure module - zero side effects, no I/O, only depends on `node:crypto`.
 *
 * Error contracts:
 *   encryptTokenPayload - throws on programmer error (empty pid, wrong key length)
 *   decryptTokenPayload - NEVER throws; returns null on every failure (bad input, wrong key,
 *                         tamper, replay, parse error) - safe to call without try/catch
 *
 * Key derivation note: the 64-hex-char path produces a full-entropy 32-byte key directly.
 * The SHA-256 passphrase path is a convenience shim - it has no salt or work factor, so
 * weak passphrases offer little protection. Production deployments MUST use a 64-char random
 * hex string for MCP4_TOKEN_KEY. Document this in env.example (Plan 02).
 *
 * Known limitation: if the IdP issues rotating refresh tokens AND the gateway restarts
 * after at least one in-session refresh, the client still holds the original envelope
 * with the now-stale `rt`. Re-auth is required (same as today). For non-rotating refresh
 * tokens, zero-reauth across arbitrary restarts is supported.
 *
 * Phase 5 (Upstream OAuth Proxy) will reuse this module unchanged. The TokenEnvelopePayload
 * interface intentionally has no `upstreamAt` / `upstreamRt` fields yet - they will be added
 * additively in Phase 5 without breaking on-disk format compatibility (decrypt is forward-tolerant
 * to extra fields).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'mcp4.v1.';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEX_KEY_LENGTH = 64; // 32 bytes encoded as hex
const HEX_REGEX = /^[0-9a-fA-F]+$/;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
// Minimum valid encoded payload: 12-byte nonce + 16-byte tag + at least 1 byte of ciphertext.
const MIN_ENCODED_BYTES = NONCE_BYTES + TAG_BYTES + 1;

export interface TokenEnvelopePayload {
  v: 1; // version (always 1 in this phase; v:2 reserved for Phase 5 widening)
  at: string; // IdP access_token (REQUIRED)
  rt?: string; // IdP refresh_token (OPTIONAL - non-rotating IdPs may omit)
  exp?: number; // access token expiry, ms since epoch
  cid?: string; // OAuth client_id
  sc?: string[]; // scopes
  pid: string; // profile_id (REQUIRED - also bound as AAD)
  iat: number; // issued-at, ms since epoch
  creg?: {
    id: string; // client_id
    ru?: string[]; // redirect_uris
    gt?: string[]; // grant_types
    rt_?: string[]; // response_types (suffix `_` avoids collision with payload-level rt)
    sc?: string; // scope (single string, matches OAuth registration shape)
    // NB: client_secret intentionally absent - DCR public PKCE clients have none.
  };
}

/**
 * Derive a 32-byte AES-256 key from a raw secret string.
 *
 * - Exactly 64 hex characters → `Buffer.from(raw, 'hex')` (full-entropy direct).
 * - Otherwise → `SHA-256(raw)` (convenience for passphrases; no salt/work factor).
 */
export function deriveTokenKey(raw: string): Buffer {
  if (raw.length === HEX_KEY_LENGTH && HEX_REGEX.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return createHash('sha256').update(raw).digest();
}

/**
 * O(1) format check - returns true only for strings that begin with the
 * `mcp4.v1.` magic prefix. Does NOT attempt decryption.
 */
export function isEncryptedToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith(TOKEN_PREFIX);
}

/**
 * Encrypt a token envelope payload as `mcp4.v1.<base64url(nonce|ciphertext|tag)>`.
 *
 * Throws on programmer error: empty `pid` (AAD binding would be meaningless) or
 * a key whose length is not 32 bytes (AES-256 requires exactly 256 bits).
 */
export function encryptTokenPayload(payload: TokenEnvelopePayload, key: Buffer): string {
  if (
    !payload.pid ||
    !Buffer.isBuffer(key) ||
    key.length !== KEY_BYTES
  ) {
    throw new Error(
      `encryptTokenPayload: payload.pid must be non-empty and key must be a ${KEY_BYTES}-byte Buffer`,
    );
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(payload.pid, 'utf8'));

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return TOKEN_PREFIX + Buffer.concat([nonce, ciphertext, tag]).toString('base64url');
}

/**
 * Decrypt a `mcp4.v1.` envelope. Returns `null` on every failure mode:
 *  - missing/invalid prefix
 *  - non-string input (null, undefined, object, etc.)
 *  - invalid base64url
 *  - truncated payload (< nonce+tag+1 bytes)
 *  - wrong key (auth tag verification failure)
 *  - tampered ciphertext or tag
 *  - AAD/profile mismatch (cross-profile replay)
 *  - malformed JSON in plaintext
 *  - version mismatch (v !== 1)
 *  - missing/wrong-typed required fields (`at`, `pid`)
 *
 * NEVER throws. Safe to call without try/catch.
 */
export function decryptTokenPayload(
  token: string,
  key: Buffer,
  profileId: string,
): TokenEnvelopePayload | null {
  try {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      return null;
    }
    if (typeof profileId !== 'string' || profileId.length === 0) {
      return null;
    }

    const suffix = token.slice(TOKEN_PREFIX.length);
    if (suffix.length === 0) {
      return null;
    }

    const decoded = decodeBase64UrlStrict(suffix);
    if (decoded === null) {
      return null;
    }
    if (decoded.length < MIN_ENCODED_BYTES) {
      return null;
    }

    const nonce = decoded.subarray(0, NONCE_BYTES);
    const tag = decoded.subarray(decoded.length - TAG_BYTES);
    const ciphertext = decoded.subarray(NONCE_BYTES, decoded.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(Buffer.from(profileId, 'utf8'));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.v !== 1) {
      return null;
    }
    if (typeof candidate.at !== 'string') {
      return null;
    }
    if (candidate.pid !== profileId) {
      return null;
    }
    if (typeof candidate.iat !== 'number') {
      return null;
    }

    return candidate as unknown as TokenEnvelopePayload;
  } catch {
    return null;
  }
}

/**
 * Strict base64url decoder. `Buffer.from(value, 'base64url')` is permissive and
 * silently drops invalid characters; this wrapper rejects any input that does
 * not strictly match the base64url alphabet so tamper / typo detection remains
 * deterministic.
 */
function decodeBase64UrlStrict(value: string): Buffer | null {
  if (value.length === 0) {
    return null;
  }
  // base64url alphabet: A-Z a-z 0-9 - _  (no padding expected, but tolerate '=')
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    return null;
  }
  return Buffer.from(value, 'base64url');
}
