import { createHash } from 'node:crypto';

const PSEUDONYM_PREFIX = 'pseudonym-sha256-';
const TRUNCATED_HASH_HEX_LENGTH = 32;

export function pseudonymizeSubject(subject: string): string {
  const hash = createHash('sha256').update(subject).digest('hex').slice(0, TRUNCATED_HASH_HEX_LENGTH);
  return `${PSEUDONYM_PREFIX}${hash}`;
}