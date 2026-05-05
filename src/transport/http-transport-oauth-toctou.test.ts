/**
 * Tests the TOCTOU catch path in getProfileState() where ExternalOAuthProvider
 * constructor throws after isOAuthConfigOperational() returns operational=true.
 *
 * Isolated in a separate file because vi.mock() is file-scoped and hoisted —
 * mocking ExternalOAuthProvider to throw would break all other transport tests.
 */

import { vi, describe, it, expect } from 'vitest';
import { describeIfListen } from '../testing/listen-support.js';

vi.mock('../auth/oauth-provider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../auth/oauth-provider.js')>();
  return {
    ...original,
    ExternalOAuthProvider: class {
      constructor() {
        throw new Error('TOCTOU: env var removed between check and construction');
      }
    },
  };
});

import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';

describeIfListen('HttpTransport — OAuth TOCTOU catch path', () => {
  it('sets oauthDisabledReason and null oauthProvider when ExternalOAuthProvider constructor throws after operational pre-flight', async () => {
    const logger = new ConsoleLogger();
    // All required fields present as literals — isOAuthConfigOperational returns true.
    // The mocked constructor then throws, exercising the catch path at getProfileState():517-519.
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        oauthConfig: {
          issuer: 'https://auth.example.com',
          redirect_uri: 'https://app/callback',
          client_id: 'test-client',
          client_secret: 'test-secret',
        },
      },
      logger,
    );

    await (transport as any).getProfileState('default');

    const profileState = (transport as any).profileStates.get('default');
    expect(profileState.oauthProvider).toBeNull();
    expect(typeof profileState.oauthDisabledReason).toBe('string');
    expect(profileState.oauthDisabledReason).toContain('TOCTOU');

    transport.stop();
  });
});
