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
 * The passphrase path uses scrypt with a fixed application salt as a work-factor KDF
 * (CWE-916 remediation). A fixed salt cannot prevent cross-deployment rainbow tables,
 * so production deployments SHOULD use a 64-char random hex string for MCP4_OAUTH_KEY.
 * Backward compatibility: envelopes encrypted with the former SHA-256 passphrase KDF
 * still decrypt via the optional fallbackKey parameter (see decryptTokenPayload);
 * new envelopes are always scrypt-derived. SHA-256 fallback removal tracked in TODO.md.
 *
 * Known limitation: if the IdP issues rotating refresh tokens AND the gateway restarts
 * after at least one in-session refresh, the client still holds the original envelope
 * with the now-stale `rt`. Re-auth is required (same as today). For non-rotating refresh
 * tokens, zero-reauth across arbitrary restarts is supported.
 *
 * Rotation note: client-facing refresh envelopes carry a `fid` (family) and
 * `jti` (per-token) so the gateway can rotate them and detect reuse (see
 * refresh-rotation-store.ts). The rotation state is process-local, so a restart
 * resets it: a client's latest envelope is accepted on first use and re-anchors
 * its family, preserving restart-recovery; a pre-restart superseded token is
 * accepted once after a restart. Legacy envelopes without `fid`/`jti` decrypt
 * unchanged and age out on the next refresh.
 *
 * Phase 5 (Upstream OAuth Proxy) will reuse this module unchanged. The TokenEnvelopePayload
 * interface intentionally has no `upstreamAt` / `upstreamRt` fields yet - they will be added
 * additively in Phase 5 without breaking on-disk format compatibility (decrypt is forward-tolerant
 * to extra fields).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { AuthenticationError, ValidationError } from '../core/errors.js';
import { normalizeIssuer } from './issuer.js';

const TOKEN_PREFIX = 'mcp4.v1.';
/**
 * Refresh envelopes use their own prefix and AAD suffix. The prefix check is
 * the first gate - an access-token path rejects `mcp4.r1.` before any crypto
 * runs. The distinct AAD suffix is defense-in-depth: a relabeled envelope
 * still fails authenticated decryption instead of relying on a field check.
 */
const REFRESH_TOKEN_PREFIX = 'mcp4.r1.';
const REFRESH_AAD_SUFFIX = ':refresh';
/**
 * How long a refresh-token identity binding stays valid before re-auth.
 * Shared horizon: the in-memory identity map in oauth-provider and the
 * refresh-envelope `iat` age check below enforce the same limit, so a
 * client-side envelope cannot rebind the human subject past the horizon
 * the server-side map enforces.
 */
export const REFRESH_IDENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Tolerated forward clock skew when validating a refresh envelope `iat`.
const IAT_FUTURE_SKEW_MS = 60 * 1000;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEX_KEY_LENGTH = 64; // 32 bytes encoded as hex
const HEX_REGEX = /^[0-9a-fA-F]+$/;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
// Fixed application salt for the scrypt passphrase path (see deriveTokenKey docs).
const SCRYPT_SALT = 'mcp4openapi:token-envelope:v1';
// Minimum valid encoded payload: 12-byte nonce + 16-byte tag + at least 1 byte of ciphertext.
const MIN_ENCODED_BYTES = NONCE_BYTES + TAG_BYTES + 1;

export interface TokenEnvelopePayload {
  v: 1; // version (always 1 in this phase; v:2 reserved for Phase 5 widening)
  at: string; // IdP access_token (REQUIRED)
  rt?: string; // IdP refresh_token (OPTIONAL - non-rotating IdPs may omit)
  exp?: number; // access token expiry, ms since epoch
  cid?: string; // OAuth client_id
  sc?: string[]; // scopes
  sub?: string; // verified OIDC subject (Entra oid when available)
  iss?: string; // verified OIDC issuer
  tid?: string; // verified OIDC tenant id
  pid: string; // profile_id (REQUIRED - also bound as AAD)
  iat: number; // issued-at, ms since epoch
  creg?: {
    id: string; // client_id
    ru?: string[]; // redirect_uris
    gt?: string[]; // grant_types
    rt_?: string[]; // response_types (suffix `_` avoids collision with payload-level rt)
    sc?: string; // scope (single string, matches OAuth registration shape)
    // NB: secret intentionally absent - DCR public PKCE clients have none.
  };
}

/**
 * Refresh envelope payload.
 *
 * Carries the verified human identity alongside the IdP refresh token, so a
 * direct `refresh_token` grant after a gateway restart can rebind the identity
 * instead of falling back to the process-local map, which is empty then.
 */
export interface RefreshEnvelopePayload {
  v: 1;
  rt: string; // IdP refresh_token (REQUIRED)
  cid: string; // OAuth client_id the refresh token was issued to
  sub?: string; // verified OIDC subject
  iss?: string; // verified OIDC issuer
  tid?: string; // verified OIDC tenant id
  pid: string; // profile_id (REQUIRED - also bound as AAD)
  iat: number; // issued-at, ms since epoch
  // Rotation (OAuth 2.1 §4.3.1). OPTIONAL for backward compatibility: envelopes
  // issued before rotation landed omit both and age out on first refresh.
  fid?: string; // rotation family id (stable across a chain)
  jti?: string; // this token's unique id within the family (rotated each refresh)
}

/** O(1) format check for `mcp4.r1.` refresh envelopes. Does NOT decrypt. */
export function isRefreshEnvelope(token: string): boolean {
  return typeof token === 'string' && token.startsWith(REFRESH_TOKEN_PREFIX);
}

/** Encrypt a refresh envelope as `mcp4.r1.<base64url(nonce|ciphertext|tag)>`. */
export function encryptRefreshEnvelope(payload: RefreshEnvelopePayload, key: Buffer): string {
  if (!payload.pid || !payload.rt || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new ValidationError(
      `encryptRefreshEnvelope: payload.pid and payload.rt must be non-empty and key must be a ${KEY_BYTES}-byte Buffer`,
    );
  }

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(payload.pid + REFRESH_AAD_SUFFIX, 'utf8'));

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return REFRESH_TOKEN_PREFIX + Buffer.concat([nonce, ciphertext, tag]).toString('base64url');
}

/**
 * Decrypt a `mcp4.r1.` refresh envelope. Returns null on every failure mode,
 * including an `iat` older than REFRESH_IDENTITY_TTL_MS or future-dated beyond
 * IAT_FUTURE_SKEW_MS. Never throws. Retries once with `fallbackKey` for
 * legacy-KDF deployments.
 */
export function decryptRefreshEnvelope(
  token: string,
  key: Buffer,
  profileId: string,
  fallbackKey?: Buffer,
): RefreshEnvelopePayload | null {
  const primary = attemptRefreshDecrypt(token, key, profileId);
  if (primary !== null) return primary;
  if (fallbackKey !== undefined) return attemptRefreshDecrypt(token, fallbackKey, profileId);
  return null;
}

function attemptRefreshDecrypt(
  token: string,
  key: Buffer,
  profileId: string,
): RefreshEnvelopePayload | null {
  if (typeof profileId !== 'string' || profileId.length === 0) return null;

  const candidate = decryptAeadJson(token, REFRESH_TOKEN_PREFIX, key, profileId + REFRESH_AAD_SUFFIX);
  if (candidate === null) return null;

  if (candidate.v !== 1) return null;
  if (typeof candidate.rt !== 'string' || candidate.rt.length === 0) return null;
  if (typeof candidate.cid !== 'string' || candidate.cid.length === 0) return null;
  if (candidate.pid !== profileId) return null;
  if (typeof candidate.iat !== 'number') return null;
  // Age horizon: an identity-bearing envelope must not rebind the subject
  // indefinitely - enforce the same TTL as the in-memory identity map.
  const now = Date.now();
  if (candidate.iat > now + IAT_FUTURE_SKEW_MS) return null;
  if (now - candidate.iat > REFRESH_IDENTITY_TTL_MS) return null;
  // Rotation ids are optional (legacy envelopes omit them), but when present
  // they must be non-empty strings - a blank id could not track a chain.
  if (candidate.fid !== undefined && (typeof candidate.fid !== 'string' || candidate.fid.length === 0)) return null;
  if (candidate.jti !== undefined && (typeof candidate.jti !== 'string' || candidate.jti.length === 0)) return null;
  if (!validateIdentityCoherence(candidate)) return null;

  return candidate as unknown as RefreshEnvelopePayload;
}

/**
 * Enforce the envelope-to-client binding: a refresh envelope minted for client
 * A must never be redeemable by client B, otherwise B would inherit A's
 * verified identity. Throws AuthenticationError on any mismatch.
 */
export function assertRefreshEnvelopeClientBinding(
  payload: RefreshEnvelopePayload,
  presentingClientId: string,
): void {
  if (
    typeof presentingClientId !== 'string' ||
    presentingClientId.length === 0 ||
    payload.cid !== presentingClientId
  ) {
    throw new AuthenticationError('Refresh token envelope was issued to a different client');
  }
}

/**
 * Derive a 32-byte AES-256 key from a raw secret string.
 *
 * - Exactly 64 hex characters → `Buffer.from(raw, 'hex')` (full-entropy direct).
 * - Otherwise → `scrypt(raw, SCRYPT_SALT, 32)` (work-factor KDF for passphrases).
 *
 * The scrypt salt is a fixed application constant: the key must be deterministic
 * across restarts because envelopes are stored client-side with no server state.
 * This trades per-secret salting for offline-crack resistance via scrypt's work factor.
 */
export function deriveTokenKey(raw: string): Buffer {
  if (raw.length === HEX_KEY_LENGTH && HEX_REGEX.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return scryptSync(raw, SCRYPT_SALT, KEY_BYTES);
}

/**
 * Legacy SHA-256 KDF kept ONLY for decrypting envelopes issued before the
 * scrypt migration. Never use for new keys. Removal tracked in TODO.md.
 */
export function deriveLegacySha256TokenKey(raw: string): Buffer {
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
    throw new ValidationError(
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
 *
 * When `fallbackKey` is provided and decryption with `key` fails, decryption is
 * retried once with `fallbackKey` (legacy SHA-256 KDF backward compatibility).
 */
export function decryptTokenPayload(
  token: string,
  key: Buffer,
  profileId: string,
  fallbackKey?: Buffer,
): TokenEnvelopePayload | null {
  const primary = attemptDecrypt(token, key, profileId);
  if (primary !== null) {
    return primary;
  }
  // Backward compatibility: envelopes encrypted with the legacy SHA-256
  // passphrase KDF still decrypt via fallbackKey. Encryption always uses the
  // scrypt key, so legacy envelopes age out naturally on token refresh.
  if (fallbackKey !== undefined) {
    return attemptDecrypt(token, fallbackKey, profileId);
  }
  return null;
}

function attemptDecrypt(
  token: string,
  key: Buffer,
  profileId: string,
): TokenEnvelopePayload | null {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    return null;
  }

  const candidate = decryptAeadJson(token, TOKEN_PREFIX, key, profileId);
  if (candidate === null) {
    return null;
  }

  if (candidate.v !== 1) {
    return null;
  }
  if (typeof candidate.at !== 'string' || candidate.at.length === 0) {
    return null;
  }
  if (candidate.pid !== profileId) {
    return null;
  }
  if (typeof candidate.iat !== 'number') {
    return null;
  }
  if (!validateIdentityCoherence(candidate)) {
    return null;
  }

  return candidate as unknown as TokenEnvelopePayload;
}

/**
 * Shared decode -> decipher -> parse pipeline for both envelope flavors.
 * Returns the parsed JSON object, or null on every failure mode. Never throws.
 */
function decryptAeadJson(
  token: string,
  prefix: string,
  key: Buffer,
  aad: string,
): Record<string, unknown> | null {
  try {
    if (typeof token !== 'string' || !token.startsWith(prefix)) {
      return null;
    }
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      return null;
    }

    const decoded = decodeBase64UrlStrict(token.slice(prefix.length));
    if (decoded === null || decoded.length < MIN_ENCODED_BYTES) {
      return null;
    }

    const nonce = decoded.subarray(0, NONCE_BYTES);
    const tag = decoded.subarray(decoded.length - TAG_BYTES);
    const ciphertext = decoded.subarray(NONCE_BYTES, decoded.length - TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Shared identity-coherence rule for both envelope flavors:
 * - `sub` and `iss` are all-or-nothing (a subject without an issuer, or vice
 *   versa, cannot be bound to an identity),
 * - `tid` requires `sub` (a tenant without a subject is meaningless),
 * - present fields must be non-empty strings,
 * - `iss` is canonicalized via normalizeIssuer in place.
 */
function validateIdentityCoherence(candidate: Record<string, unknown>): boolean {
  const hasSubject = Object.prototype.hasOwnProperty.call(candidate, 'sub');
  const hasIssuer = Object.prototype.hasOwnProperty.call(candidate, 'iss');
  const hasTenant = Object.prototype.hasOwnProperty.call(candidate, 'tid');
  if (hasSubject !== hasIssuer || (hasTenant && !hasSubject)) {
    return false;
  }
  if (hasSubject) {
    if (
      typeof candidate.sub !== 'string' ||
      candidate.sub.length === 0 ||
      typeof candidate.iss !== 'string' ||
      candidate.iss.length === 0
    ) {
      return false;
    }
    const issuer = normalizeIssuer(candidate.iss);
    if (issuer.length === 0) {
      return false;
    }
    candidate.iss = issuer;
  }
  if (hasTenant && (typeof candidate.tid !== 'string' || candidate.tid.length === 0)) {
    return false;
  }
  return true;
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
