import { createHash, createHmac } from 'node:crypto';

const PSEUDONYM_PREFIX = 'pseudonym-sha256-';
const TRUNCATED_HASH_HEX_LENGTH = 32;
// Domain-separation label: the pseudonym HMAC key is derived from the provided
// key material, so the token encryption key is never reused directly.
const PSEUDONYM_KEY_LABEL = 'mcp4-pseudonym:';

let hmacKey: Buffer | undefined;

/**
 * Configure keyed pseudonymization for observability output.
 *
 * Pass the deployment token key material (for example the tokenKey derived from
 * MCP4_OAUTH_KEY); the HMAC key is derived internally as
 * sha256(PSEUDONYM_KEY_LABEL + material). Pass undefined to restore the
 * unkeyed SHA-256 fallback.
 */
export function configureObservabilityPseudonym(key: string | Buffer | undefined): void {
  hmacKey = key === undefined || key.length === 0
    ? undefined
    : createHash('sha256').update(PSEUDONYM_KEY_LABEL).update(key).digest();
}

/**
 * Pseudonymize an OIDC subject for logs and metrics.
 *
 * With a configured key this is a truncated HMAC-SHA256: not reversible via
 * dictionary attack and not linkable across deployments with different keys.
 * Without a key it falls back to an unsalted truncated SHA-256, which is
 * deterministic across deployments and dictionary-reversible for guessable
 * subjects (emails, usernames) - configure a key in production.
 */
export function pseudonymizeSubject(subject: string): string {
  const digest = hmacKey
    ? createHmac('sha256', hmacKey).update(subject).digest('hex')
    : createHash('sha256').update(subject).digest('hex');
  return `${PSEUDONYM_PREFIX}${digest.slice(0, TRUNCATED_HASH_HEX_LENGTH)}`;
}
