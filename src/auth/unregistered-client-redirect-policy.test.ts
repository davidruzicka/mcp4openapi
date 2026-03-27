import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../core/logger.js';
import { isApprovedUnregisteredClientRedirectUri } from './unregistered-client-redirect-policy.js';

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('isApprovedUnregisteredClientRedirectUri', () => {
  it('allows loopback origin rules with dynamic ports', () => {
    const logger = createLogger();

    expect(
      isApprovedUnregisteredClientRedirectUri(
        'http://localhost:43123/oauth/callback',
        ['http://localhost'],
        logger,
      ),
    ).toBe(true);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'http://127.0.0.1:3000/oauth/callback',
        ['http://127.0.0.1'],
        logger,
      ),
    ).toBe(true);
  });

  it('rejects host confusion attacks for loopback approvals', () => {
    const logger = createLogger();

    expect(
      isApprovedUnregisteredClientRedirectUri(
        'http://localhost.evil.test/callback',
        ['http://localhost'],
        logger,
      ),
    ).toBe(false);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'http://localhost@evil.test/callback',
        ['http://localhost'],
        logger,
      ),
    ).toBe(false);
  });

  it('supports exact custom-scheme host approvals', () => {
    const logger = createLogger();

    expect(
      isApprovedUnregisteredClientRedirectUri(
        'cursor://anysphere.cursor-mcp/oauth/callback',
        ['cursor://anysphere.cursor-mcp'],
        logger,
      ),
    ).toBe(true);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'cursor://other-client/oauth/callback',
        ['cursor://anysphere.cursor-mcp'],
        logger,
      ),
    ).toBe(false);
  });

  it('supports explicit scheme-only approvals', () => {
    const logger = createLogger();

    expect(
      isApprovedUnregisteredClientRedirectUri(
        'cursor://any-client/oauth/callback',
        ['cursor://'],
        logger,
      ),
    ).toBe(true);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'vscode://mcp/callback',
        ['cursor://'],
        logger,
      ),
    ).toBe(false);
  });
});