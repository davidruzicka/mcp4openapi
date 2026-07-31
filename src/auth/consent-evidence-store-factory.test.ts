import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '../core/logger.js';
import { createConsentEvidenceStore } from './consent-evidence-store-factory.js';
import {
  FileConsentEvidenceStore,
  InMemoryConsentEvidenceStore,
} from './consent-evidence-store.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('createConsentEvidenceStore', () => {
  const prev = process.env.MCP4_CONSENT_EVIDENCE_PATH;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-factory-'));
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.MCP4_CONSENT_EVIDENCE_PATH;
    else process.env.MCP4_CONSENT_EVIDENCE_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an in-memory store when MCP4_CONSENT_EVIDENCE_PATH is unset', () => {
    delete process.env.MCP4_CONSENT_EVIDENCE_PATH;
    expect(createConsentEvidenceStore(logger)).toBeInstanceOf(InMemoryConsentEvidenceStore);
  });

  it('returns a file-backed store when MCP4_CONSENT_EVIDENCE_PATH is set', () => {
    process.env.MCP4_CONSENT_EVIDENCE_PATH = path.join(dir, 'evidence.jsonl');
    expect(createConsentEvidenceStore(logger)).toBeInstanceOf(FileConsentEvidenceStore);
  });

  it('ignores a blank MCP4_CONSENT_EVIDENCE_PATH and falls back to in-memory', () => {
    process.env.MCP4_CONSENT_EVIDENCE_PATH = '   ';
    expect(createConsentEvidenceStore(logger)).toBeInstanceOf(InMemoryConsentEvidenceStore);
  });
});
