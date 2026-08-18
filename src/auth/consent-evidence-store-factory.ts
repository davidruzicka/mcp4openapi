import type { Logger } from '../core/logger.js';
import type { ConsentEvidenceStore } from './consent-evidence-store.js';
import { FileConsentEvidenceStore, InMemoryConsentEvidenceStore } from './consent-evidence-store.js';
import type { PostgresConsentDbConfig } from './postgres-consent-evidence-store.js';
import { PostgresConsentEvidenceStore } from './postgres-consent-evidence-store.js';
import { ConsentGateConfigurationError } from '../core/errors.js';

export interface ConsentEvidenceStoreConfig {
  /** Postgres connection settings (`MCP_CONSENTS_DB_*`), when configured. */
  db?: PostgresConsentDbConfig;
  /** Absolute path of the durable JSONL evidence file, when configured. */
  evidencePath?: string;
  /** True when the profile declares `consent_gate.required`. */
  consentRequired: boolean;
  logger: Logger;
}

/**
 * Construct a `ConsentEvidenceStore` from resolved configuration.
 *
 * Backend precedence: Postgres (transactional, multi-replica) over the JSONL
 * file (durable, single-node) over in-memory (dev only). Required consent with
 * neither a database nor an evidence path is a hard startup failure, in every
 * environment: volatile storage would drop every grant on restart and let a
 * "consent recorded" claim silently mean nothing. The check is deliberately not
 * conditioned on a production signal - the codebase has no such convention, and
 * an environment-dependent guard is untestable without mutating `process.env`.
 *
 * Callers pass the settings in rather than the factory reading the environment,
 * so store selection is a pure function of resolved config.
 */
export function createConsentEvidenceStore(config: ConsentEvidenceStoreConfig): ConsentEvidenceStore {
  if (config.db) {
    config.logger.info('Using Postgres consent evidence store', {
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
    });
    return new PostgresConsentEvidenceStore(config.db, config.logger);
  }
  const path = config.evidencePath?.trim();
  if (!path) {
    if (config.consentRequired) {
      throw new ConsentGateConfigurationError(
        'Required consent gate needs a durable evidence store: set the MCP_CONSENTS_DB_* variables or MCP4_CONSENT_EVIDENCE_PATH',
      );
    }
    return new InMemoryConsentEvidenceStore();
  }
  config.logger.info('Using file-backed consent evidence store', { path });
  return new FileConsentEvidenceStore(path, config.logger);
}
