import { describe, it, expect, afterEach } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import { createHttpTransportTestHarness } from './http-transport.test-harness.js';

describe('createHttpTransportTestHarness', () => {
  const logger = new ConsoleLogger();
  const transports: HttpTransport[] = [];

  afterEach(async () => {
    await Promise.all(transports.map(async (transport) => transport.stop()));
    transports.length = 0;
  });

  const createTransport = (): HttpTransport => {
    const transport = new HttpTransport(
      {
        host: '127.0.0.1',
        port: 0,
        sessionTimeoutMs: 1800000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
      },
      logger,
    );
    transports.push(transport);
    return transport;
  };

  it('creates seeded profile state and manages sessions through typed helpers', () => {
    const harness = createHttpTransportTestHarness(createTransport());
    const profileState = harness.createProfileState();

    const sessionId = harness.createSession(profileState, {
      authToken: 'access-token',
      filtering: { project_id: ['1'] },
      filteringHeader: 'project_id=1',
    });

    expect(harness.app).toBeDefined();
    expect(harness.getProfileState('default')).toBe(profileState);
    expect(profileState.sessions.get(sessionId)?.authToken).toBe('access-token');

    harness.destroySession(profileState, sessionId);
    expect(profileState.sessions.has(sessionId)).toBe(false);
  });

  it('reads header helpers through a typed request shim', () => {
    const harness = createHttpTransportTestHarness(createTransport());

    expect(harness.getFilteringHeaderValue({ headers: { 'x-mcp4-params': 'project_id=1' } })).toBe('project_id=1');
    expect(harness.getTenantIdHeaderValue({ headers: { 'x-mcp4-tenant-id': ' team-a ' } })).toBe('team-a');
    expect(harness.getToolFilterHeaderValue({ headers: { 'x-mcp4-tools': 'get_user' } })).toBe('get_user');
  });
});
