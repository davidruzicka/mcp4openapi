import { createHash, createHmac } from 'node:crypto';
import type { Logger } from '../core/logger.js';
import { ConsoleLogger } from '../core/logger.js';

const PSEUDONYM_PREFIX = 'pseudonym-sha256-';
const TRUNCATED_HASH_HEX_LENGTH = 32;
// Domain-separation label: the pseudonym HMAC key is derived from the provided
// key material, so the token encryption key is never reused directly.
const PSEUDONYM_KEY_LABEL = 'mcp4-pseudonym:';

let hmacKey: Buffer | undefined;
let warnLogger: Pick<Logger, 'warn'> | undefined;
// The unkeyed-fallback warning is emitted once per configuration, not per call.
let unkeyedFallbackWarned = false;

/**
 * Configure keyed pseudonymization for observability output.
 *
 * Pass the deployment token key material (for example the tokenKey derived from
 * MCP4_OAUTH_KEY); the HMAC key is derived internally as
 * sha256(PSEUDONYM_KEY_LABEL + material). Pass undefined to restore the
 * unkeyed SHA-256 fallback. An optional logger receives the one-time warning
 * emitted when the unkeyed fallback is first used.
 */
export function configureObservabilityPseudonym(
  key: string | Buffer | undefined,
  logger?: Pick<Logger, 'warn'>,
): void {
  hmacKey = key === undefined || key.length === 0
    ? undefined
    : createHash('sha256').update(PSEUDONYM_KEY_LABEL).update(key).digest();
  if (logger) warnLogger = logger;
  unkeyedFallbackWarned = false;
}

/**
 * Pseudonymize an OIDC subject for logs and metrics.
 *
 * With a configured key this is a truncated HMAC-SHA256: not reversible via
 * dictionary attack and not linkable across deployments with different keys.
 * Without a key it falls back to an unsalted truncated SHA-256, which is
 * deterministic across deployments and dictionary-reversible for guessable
 * subjects (emails, usernames) - configure a key in production. The first
 * unkeyed use logs a warning so the fallback never engages silently.
 */
export function pseudonymizeSubject(subject: string): string {
  if (!hmacKey && !unkeyedFallbackWarned) {
    unkeyedFallbackWarned = true;
    (warnLogger ??= new ConsoleLogger()).warn(
      'Observability pseudonymization has no key material configured - falling back to unkeyed truncated SHA-256, which is dictionary-reversible for guessable subjects; set MCP4_OAUTH_KEY to enable keyed pseudonyms',
    );
  }
  const digest = hmacKey
    ? createHmac('sha256', hmacKey).update(subject).digest('hex')
    : createHash('sha256').update(subject).digest('hex');
  return `${PSEUDONYM_PREFIX}${digest.slice(0, TRUNCATED_HASH_HEX_LENGTH)}`;
}
