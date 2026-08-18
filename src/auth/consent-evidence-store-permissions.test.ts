/**
 * Evidence file confidentiality.
 *
 * Vitest workers forbid `process.umask()`, so a permissive creation mask is
 * simulated by pre-creating the file with a wide mode; the store must tighten
 * the file. A pre-existing directory is operator-owned and its mode stays
 * untouched; only a directory the store created itself is set to 0700.
 * POSIX only: Windows does not model these mode bits.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Logger } from '../core/logger.js';
import { FileConsentEvidenceStore } from './consent-evidence-store.js';
import { makeContractEvidence } from '../testing/consent-store-contract.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const modeOf = (target: string): number => fs.statSync(target).mode & 0o777;

describe.sequential('FileConsentEvidenceStore permissions', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-perms-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'creates the evidence directory 0700 and the file 0600',
    async () => {
      const dir = path.join(root, 'nested', 'evidence');
      const filePath = path.join(dir, 'evidence.jsonl');
      const store = new FileConsentEvidenceStore(filePath, logger);

      await store.record(makeContractEvidence());

      expect(modeOf(dir)).toBe(0o700);
      expect(modeOf(filePath)).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'tightens an existing world-readable evidence file before appending',
    async () => {
      const dir = path.join(root, 'existing');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'evidence.jsonl');
      fs.writeFileSync(filePath, '', 'utf8');
      fs.chmodSync(filePath, 0o644);
      expect(modeOf(filePath)).toBe(0o644);

      const store = new FileConsentEvidenceStore(filePath, logger);
      await store.record(makeContractEvidence());

      expect(modeOf(filePath)).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'leaves the mode of a pre-existing directory untouched',
    async () => {
      // The directory belongs to the operator (it may hold unrelated files);
      // only a directory the store created itself is tightened to 0700.
      const dir = path.join(root, 'shared');
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o755);
      const filePath = path.join(dir, 'evidence.jsonl');

      const store = new FileConsentEvidenceStore(filePath, logger);
      await store.record(makeContractEvidence());

      expect(modeOf(dir)).toBe(0o755);
      expect(modeOf(filePath)).toBe(0o600);
    },
  );
});
