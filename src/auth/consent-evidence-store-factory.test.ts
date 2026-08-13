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
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consent-factory-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an in-memory store when consent is not required and no path is configured', () => {
    expect(createConsentEvidenceStore({ consentRequired: false, logger })).toBeInstanceOf(
      InMemoryConsentEvidenceStore,
    );
  });

  it('returns a file-backed store when a path is configured', () => {
    expect(
      createConsentEvidenceStore({
        evidencePath: path.join(dir, 'evidence.jsonl'),
        consentRequired: false,
        logger,
      }),
    ).toBeInstanceOf(FileConsentEvidenceStore);
  });

  it('returns a file-backed store when consent is required and a path is configured', () => {
    expect(
      createConsentEvidenceStore({
        evidencePath: path.join(dir, 'evidence.jsonl'),
        consentRequired: true,
        logger,
      }),
    ).toBeInstanceOf(FileConsentEvidenceStore);
  });

  it('fails closed when consent is required and no evidence path is configured', () => {
    expect(() => createConsentEvidenceStore({ consentRequired: true, logger })).toThrow(
      /Required consent gate needs a durable evidence store/,
    );
  });

  it('treats a blank path as unset', () => {
    expect(() =>
      createConsentEvidenceStore({ evidencePath: '   ', consentRequired: true, logger }),
    ).toThrow(/Required consent gate needs a durable evidence store/);
    expect(
      createConsentEvidenceStore({ evidencePath: '   ', consentRequired: false, logger }),
    ).toBeInstanceOf(InMemoryConsentEvidenceStore);
  });
});
