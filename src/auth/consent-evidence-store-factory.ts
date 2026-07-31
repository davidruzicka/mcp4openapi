import type { Logger } from '../core/logger.js';
import type { ConsentEvidenceStore } from './consent-evidence-store.js';
import { FileConsentEvidenceStore, InMemoryConsentEvidenceStore } from './consent-evidence-store.js';


/**
 * Construct a `ConsentEvidenceStore`.
 *
 * The current implementation returns an in-memory store (dev/pilot only). The
 * `Logger` parameter is retained even though the in-memory store does not use
 * it, so a future persistent backend (durable audit trail, shared across
 * replicas) can be added here without changing the call site signature.
 */
export function createConsentEvidenceStore(_logger: Logger): ConsentEvidenceStore {
  const filePath = process.env.MCP4_CONSENT_EVIDENCE_PATH?.trim();
  if (filePath) {
    return new FileConsentEvidenceStore(filePath);
  }
  return new InMemoryConsentEvidenceStore();
}
