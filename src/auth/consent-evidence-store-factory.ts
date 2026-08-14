import type { Logger } from '../core/logger.js';
import type { ConsentEvidenceStore } from './consent-evidence-store.js';
import { FileConsentEvidenceStore, InMemoryConsentEvidenceStore } from './consent-evidence-store.js';
import { ConsentGateConfigurationError } from '../core/errors.js';

export interface ConsentEvidenceStoreConfig {
  /** Absolute path of the durable JSONL evidence file, when configured. */
  evidencePath?: string;
  /** True when the profile declares `consent_gate.required`. */
  consentRequired: boolean;
  logger: Logger;
}

/**
 * Construct a `ConsentEvidenceStore` from resolved configuration.
 *
 * Required consent with no evidence path is a hard startup failure, in every
 * environment: volatile storage would drop every grant on restart and let a
 * "consent recorded" claim silently mean nothing. The check is deliberately not
 * conditioned on a production signal - the codebase has no such convention, and
 * an environment-dependent guard is untestable without mutating `process.env`.
 *
 * Callers pass the path in rather than the factory reading the environment, so
 * store selection is a pure function of resolved config.
 *
 * A transactional multi-replica backend can be added here without changing the
 * call site signature.
 */
export function createConsentEvidenceStore(config: ConsentEvidenceStoreConfig): ConsentEvidenceStore {
  const path = config.evidencePath?.trim();
  if (!path) {
    if (config.consentRequired) {
      throw new ConsentGateConfigurationError(
        'Required consent gate needs a durable evidence store: set MCP4_CONSENT_EVIDENCE_PATH to an absolute writable path',
      );
    }
    return new InMemoryConsentEvidenceStore();
  }
  config.logger.info('Using file-backed consent evidence store', { path });
  return new FileConsentEvidenceStore(path, config.logger);
}
