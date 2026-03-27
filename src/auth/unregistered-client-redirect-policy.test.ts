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
  it('rejects missing approval rules', () => {
    const logger = createLogger();

    expect(isApprovedUnregisteredClientRedirectUri('http://localhost/callback', undefined, logger)).toBe(false);
    expect(isApprovedUnregisteredClientRedirectUri('http://localhost/callback', [], logger)).toBe(false);
  });

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
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'https://service.example.com/callback',
        ['https://service.example.com'],
        logger,
      ),
    ).toBe(true);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'http://service.example.com/callback',
        ['http://service.example.com'],
        logger,
      ),
    ).toBe(true);
  });

  it('requires exact ports for non-loopback approvals', () => {
    const logger = createLogger();

    expect(
      isApprovedUnregisteredClientRedirectUri(
        'https://service.example.com:8443/callback',
        ['https://service.example.com'],
        logger,
      ),
    ).toBe(false);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'https://service.example.com:8443/callback',
        ['https://service.example.com:8443'],
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

  it('supports approved path prefixes and rejects sibling or protocol-mismatched paths', () => {
    const logger = createLogger();

    expect(
      isApprovedUnregisteredClientRedirectUri(
        'https://service.example.com/oauth/callback/child',
        ['https://service.example.com/oauth/callback'],
        logger,
      ),
    ).toBe(true);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'https://service.example.com/oauth/other',
        ['https://service.example.com/oauth/callback'],
        logger,
      ),
    ).toBe(false);
    expect(
      isApprovedUnregisteredClientRedirectUri(
        'https://service.example.com/oauth/callback',
        ['http://service.example.com/oauth/callback'],
        logger,
      ),
    ).toBe(false);
  });

  it('rejects invalid or dangerous redirect URIs', () => {
    const logger = createLogger();

    expect(isApprovedUnregisteredClientRedirectUri('not-a-url', ['http://localhost'], logger)).toBe(false);
    expect(isApprovedUnregisteredClientRedirectUri('javascript:alert(1)', ['javascript://'], logger)).toBe(false);
    expect(isApprovedUnregisteredClientRedirectUri('cursor://client/callback#fragment', ['cursor://'], logger)).toBe(false);
    expect(isApprovedUnregisteredClientRedirectUri('http:/callback', ['http://localhost'], logger)).toBe(false);
  });

  it('ignores invalid approval rules and logs a warning', () => {
    const logger = createLogger();

    expect(
      isApprovedUnregisteredClientRedirectUri(
        'https://service.example.com/callback',
        ['not-a-url', 'https://service.example.com/callback'],
        logger,
      ),
    ).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring invalid approved unregistered OAuth redirect URI rule',
      { rule: 'not-a-url' },
    );
  });
});
