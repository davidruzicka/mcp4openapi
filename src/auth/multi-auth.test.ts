/**
 * Multi-auth precedence resolution (unit).
 *
 * These tests exercise the real resolver that decides which configured auth method
 * applies to an inbound request (`HttpTransport.extractAuthToken`), rather than
 * asserting the shape of hand-built config objects. They prove that priority
 * ordering (not array order) drives selection and that the Authorization header
 * outranks lower-priority custom headers.
 *
 * Transport-boundary enforcement (OAuth-required profiles rejecting weaker methods)
 * is covered in http-transport-auth-enforcement.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from '../transport/http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import type { AuthInterceptor } from '../types/profile.js';

describe('Multi-Auth precedence resolution', () => {
  let transport: HttpTransport;

  beforeEach(() => {
    transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        metricsEnabled: false,
        defaultProfileId: 'default',
      },
      new ConsoleLogger(),
    );
  });

  afterEach(async () => {
    await transport.stop();
  });

  const resolve = (headers: Record<string, unknown>, configs: AuthInterceptor[]) =>
    (transport as any).extractAuthToken({ headers }, { sessions: new Map() }, configs);

  const oauthInterceptor = (priority?: number): AuthInterceptor => ({
    type: 'oauth',
    ...(priority !== undefined ? { priority } : {}),
    oauth_config: {
      authorization_endpoint: 'https://example.com/oauth/authorize',
      token_endpoint: 'https://example.com/oauth/token',
      scopes: ['api'],
    },
  });

  it('selects the highest-priority (lowest number) custom-header config', () => {
    const configs: AuthInterceptor[] = [
      { type: 'custom-header', header_name: 'X-Secondary', priority: 1 },
      { type: 'custom-header', header_name: 'X-Primary', priority: 0 },
    ];

    const result = resolve(
      { 'x-primary': 'primary-token', 'x-secondary': 'secondary-token' },
      configs,
    );

    expect(result).toEqual({ type: 'api-token', token: 'primary-token' });
  });

  it('reorders selection when priorities change, not by array position', () => {
    const configs: AuthInterceptor[] = [
      { type: 'custom-header', header_name: 'X-Secondary', priority: 0 },
      { type: 'custom-header', header_name: 'X-Primary', priority: 1 },
    ];

    const result = resolve(
      { 'x-primary': 'primary-token', 'x-secondary': 'secondary-token' },
      configs,
    );

    // Same array order as the previous test, only priorities swapped: the resolver
    // now picks X-Secondary, proving priority (not position) drives selection.
    expect(result).toEqual({ type: 'api-token', token: 'secondary-token' });
  });

  it('prefers an Authorization Bearer over a lower-priority custom header', () => {
    const configs: AuthInterceptor[] = [
      oauthInterceptor(0),
      { type: 'custom-header', header_name: 'X-API-Key', priority: 1 },
    ];

    const result = resolve(
      { authorization: 'Bearer oauth-access-token', 'x-api-key': 'weak-token' },
      configs,
    );

    expect(result.type).toBe('bearer');
    expect(result.token).toBe('oauth-access-token');
  });

  it('classifies a session-fallback token as oauth when an oauth config is present', () => {
    const sessions = new Map<string, { authToken: string }>([['sid', { authToken: 'sess-token' }]]);

    const result = (transport as any).extractAuthToken(
      { headers: { 'mcp-session-id': 'sid' } },
      { sessions },
      [oauthInterceptor()],
    );

    expect(result).toEqual({ type: 'oauth', token: 'sess-token', sessionId: 'sid' });
  });

  it('classifies a session-fallback token as api-token when no oauth config is present', () => {
    const sessions = new Map<string, { authToken: string }>([['sid', { authToken: 'sess-token' }]]);

    const result = (transport as any).extractAuthToken(
      { headers: { 'mcp-session-id': 'sid' } },
      { sessions },
      [{ type: 'custom-header', header_name: 'X-API-Key', priority: 0 }],
    );

    expect(result).toEqual({ type: 'api-token', token: 'sess-token', sessionId: 'sid' });
  });
});
