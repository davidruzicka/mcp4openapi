import type { Logger } from '../core/logger.js';
import type { ConsentEvidenceStore } from './consent-evidence-store.js';
import { FileConsentEvidenceStore, InMemoryConsentEvidenceStore } from './consent-evidence-store.js';

/**
 * Construct a `ConsentEvidenceStore`.
 *
 * When `MCP4_CONSENT_EVIDENCE_PATH` is set to an absolute writable path, a
 * durable append-only JSONL `FileConsentEvidenceStore` is used (single-node /
 * staging). Otherwise an in-memory store is returned, which is dev/test only
 * (lost on restart, not shared across replicas). A transactional multi-replica
 * backend can be added here without changing the call site signature.
 */
export function createConsentEvidenceStore(logger: Logger): ConsentEvidenceStore {
  const path = process.env.MCP4_CONSENT_EVIDENCE_PATH?.trim();
  if (path) {
    logger.info('Using file-backed consent evidence store', { path });
    return new FileConsentEvidenceStore(path, logger);
  }
  return new InMemoryConsentEvidenceStore();
}
