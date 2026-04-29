/**
 * Integration tests for the client auth gate session-init flow (Phase 3).
 *
 * Test scenarios cover the eight matrix points from plan 03-03 task 3:
 *   1. API key valid -> 200 + session.clientPrincipal populated (authType='token')
 *   2. API key invalid -> 401
 *   3. mode='optional', no token -> 200 + clientPrincipal undefined
 *   4. mode='required', no token -> 401
 *   5. authConfigs guard bypass, mode='optional' -> 200 (the `!gate &&` prefix
 *      added in change C is the load-bearing line under test)
 *   6. authConfigs guard bypass, mode='required' -> 401 (bypass is mode-aware)
 *   7. No client_auth_gate configured -> 200 (regression guard for existing flow)
 *   8. Non-ClientAuthGateError from gate -> 401 (all gate exceptions map to 401)
 *
 * The tests follow the http-transport-auth-enforcement.test.ts pattern:
 * mock req/res objects, drive `handlePost` directly, assert on res state
 * and read `profileStates` directly to verify session.clientPrincipal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import type { AuthInterceptor, ClientAuthGateConfig } from '../types/profile.js';
import type { HttpProfileContext } from '../types/http-transport.js';

const VALID_KEY_ENV = 'CLIENT_AUTH_GATE_INTEGRATION_KEY';
const VALID_KEY = 'integration-test-secret-key-1234';
const SUBJECT = 'svc-integration';

function makeReq(authHeader?: string) {
  return {
    method: 'POST',
    url: '/mcp',
    path: '/mcp',
    headers: {
      'content-type': 'application/json',
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    body: {
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
      id: 1,
    },
    get: (name: string) => {
      if (name === 'content-type') return 'application/json';
      return undefined;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function makeTransport(): HttpTransport {
  const config = {
    host: '127.0.0.1',
    port: 0,
    sessionTimeoutMs: 1800000,
    heartbeatEnabled: false,
    heartbeatIntervalMs: 30000,
    metricsEnabled: false,
    metricsPath: '/metrics',
    defaultProfileId: 'default',
  };
  return new HttpTransport(config, new ConsoleLogger());
}

function getSession(transport: HttpTransport, profileId: string, sessionId: string) {
  const states = (transport as unknown as { profileStates: Map<string, { sessions: Map<string, unknown> }> }).profileStates;
  return states.get(profileId)?.sessions.get(sessionId);
}

describe('Client auth gate (Phase 3) — session init integration', () => {
  let transport: HttpTransport;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[VALID_KEY_ENV];
    process.env[VALID_KEY_ENV] = VALID_KEY;
    transport = makeTransport();
    transport.setMessageHandler(async () => ({
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'server', version: '1.0' },
      },
    }));
  });

  afterEach(async () => {
    await transport.stop();
    if (prevEnv === undefined) delete process.env[VALID_KEY_ENV];
    else process.env[VALID_KEY_ENV] = prevEnv;
  });

  // Scenario 1
  it('accepts valid API key and populates session.clientPrincipal with authType=token', async () => {
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      client_auth_gate: {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: VALID_KEY_ENV, subject: SUBJECT, scopes: ['read'] }],
        },
      } satisfies ClientAuthGateConfig,
    };
    transport.setProfileContextProvider(async () => profileContext);

    const req = makeReq(`Bearer ${VALID_KEY}`);
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(200);
    const sessionId = res.headers['Mcp-Session-Id'];
    expect(sessionId).toBeTruthy();
    const session = getSession(transport, 'default', sessionId!) as
      | { clientPrincipal?: { authType: string; subject: string; scopes: string[]; profileId: string } }
      | undefined;
    expect(session).toBeDefined();
    expect(session!.clientPrincipal).toBeDefined();
    expect(session!.clientPrincipal!.authType).toBe('token');
    expect(session!.clientPrincipal!.subject).toBe(SUBJECT);
    expect(session!.clientPrincipal!.profileId).toBe('default');
    expect(session!.clientPrincipal!.scopes).toEqual(['read']);
  });

  // Scenario 2
  it('rejects invalid API key with 401 and creates no session', async () => {
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      client_auth_gate: {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: VALID_KEY_ENV, subject: SUBJECT }],
        },
      },
    };
    transport.setProfileContextProvider(async () => profileContext);

    const req = makeReq('Bearer this-is-not-a-real-key');
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'Unauthorized' }));
    // No Mcp-Session-Id was set on rejection.
    expect(res.headers['Mcp-Session-Id']).toBeUndefined();
  });

  // Scenario 3
  it('mode=optional + no token -> 200 with undefined clientPrincipal', async () => {
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      client_auth_gate: {
        mode: 'optional',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: VALID_KEY_ENV, subject: SUBJECT }],
        },
      },
    };
    transport.setProfileContextProvider(async () => profileContext);

    const req = makeReq();
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(200);
    const sessionId = res.headers['Mcp-Session-Id'];
    expect(sessionId).toBeTruthy();
    const session = getSession(transport, 'default', sessionId!) as
      | { clientPrincipal?: unknown }
      | undefined;
    expect(session).toBeDefined();
    expect(session!.clientPrincipal).toBeUndefined();
  });

  // Scenario 4
  it('mode=required + no token -> 401', async () => {
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      client_auth_gate: {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: VALID_KEY_ENV, subject: SUBJECT }],
        },
      },
    };
    transport.setProfileContextProvider(async () => profileContext);

    const req = makeReq();
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(401);
  });

  // Scenario 5
  it('mode=optional + authConfigs configured + no token -> 200 (guard bypass)', async () => {
    const authConfig: AuthInterceptor = {
      type: 'bearer',
      // No value_from_env -> hasServerEnvAuthToken returns false -> the
      // existing guard would 401 if not bypassed by `!gate`. The bypass is
      // exactly what we are pinning here.
    };
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      authConfigs: [authConfig],
      client_auth_gate: { mode: 'optional' },
      // baseUrl intentionally omitted to keep the post-guard validation block
      // from firing on this path.
    };
    transport.setProfileContextProvider(async () => profileContext);

    const req = makeReq();
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(200);
    const sessionId = res.headers['Mcp-Session-Id'];
    expect(sessionId).toBeTruthy();
    const session = getSession(transport, 'default', sessionId!) as
      | { clientPrincipal?: unknown }
      | undefined;
    expect(session!.clientPrincipal).toBeUndefined();
  });

  // Scenario 6
  it('mode=required + authConfigs configured + no token -> 401 (bypass is mode-aware)', async () => {
    const authConfig: AuthInterceptor = { type: 'bearer' };
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      authConfigs: [authConfig],
      client_auth_gate: { mode: 'required' },
    };
    transport.setProfileContextProvider(async () => profileContext);

    const req = makeReq();
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(401);
  });

  // Scenario 7
  it('regression: profile without client_auth_gate -> existing flow unchanged', async () => {
    // No client_auth_gate, no authConfigs: the gate must not be invoked and
    // session must be created cleanly with clientPrincipal undefined.
    const profileContext: HttpProfileContext = {
      profileId: 'default',
    };
    transport.setProfileContextProvider(async () => profileContext);

    const req = makeReq();
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(200);
    const sessionId = res.headers['Mcp-Session-Id'];
    expect(sessionId).toBeTruthy();
    const session = getSession(transport, 'default', sessionId!) as
      | { clientPrincipal?: unknown }
      | undefined;
    expect(session).toBeDefined();
    expect(session!.clientPrincipal).toBeUndefined();
  });

  // Scenario 8 — generic Error (not ClientAuthGateError) from the gate
  it('non-ClientAuthGateError from gate -> 401 (all gate exceptions mapped)', async () => {
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      client_auth_gate: {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: VALID_KEY_ENV, subject: SUBJECT }],
        },
      },
    };
    transport.setProfileContextProvider(async () => profileContext);

    // Trigger getProfileState() once to construct the gate, then monkey-patch
    // the gate's apiKeyStore to throw a generic Error. We can't intercept
    // earlier (the constructor runs synchronously inside getProfileState),
    // and we don't want to test against ClientAuthGateError because Scenario
    // 2 already covers that path — the point here is to pin the
    // "all exceptions map to 401" contract for unexpected store errors.
    await (transport as unknown as { getProfileState: (id: string) => Promise<unknown> }).getProfileState('default');
    const profileState = (
      transport as unknown as {
        profileStates: Map<string, { clientAuthGate?: { ['apiKeyStore']: { validate: (k: string) => Promise<unknown> } } }>;
      }
    ).profileStates.get('default')!;
    const gate = profileState.clientAuthGate!;
    // Override apiKeyStore.validate to throw a generic Error.
    (gate as unknown as { apiKeyStore: { validate: (k: string) => Promise<unknown> } }).apiKeyStore.validate = async () => {
      throw new Error('upstream store unreachable');
    };

    const logger = (transport as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger;
    const warnSpy = vi.spyOn(logger, 'warn');

    const req = makeReq(`Bearer ${VALID_KEY}`);
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'Unauthorized' }));
    expect(warnSpy).toHaveBeenCalledWith(
      'Client auth gate rejected session init',
      expect.objectContaining({ errorType: 'unknown' }),
    );
  });

  // Scenario 9 — ClientAuthGateError logs errorType='ClientAuthGateError'
  it('ClientAuthGateError from gate -> 401 + warn log with errorType=ClientAuthGateError', async () => {
    // Pins the discriminator in the warn log: ops teams distinguish known auth
    // rejections ('ClientAuthGateError') from unexpected store failures ('unknown').
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      client_auth_gate: {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: VALID_KEY_ENV, subject: SUBJECT }],
        },
      },
    };
    transport.setProfileContextProvider(async () => profileContext);

    const logger = (transport as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger;
    const warnSpy = vi.spyOn(logger, 'warn');

    const req = makeReq('Bearer wrong-key');
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(401);
    expect(warnSpy).toHaveBeenCalledWith(
      'Client auth gate rejected session init',
      expect.objectContaining({ errorType: 'ClientAuthGateError' }),
    );
  });

  // Scenario 10 — session-creation log includes clientSubject + clientAuthType
  it('valid API key -> session-creation log includes clientSubject and clientAuthType', async () => {
    // Pins AUTH-03 (partial): structured identity fields must appear in logger.info
    // at session creation so Phase 5 audit log can read them from session context.
    const profileContext: HttpProfileContext = {
      profileId: 'default',
      client_auth_gate: {
        mode: 'required',
        api_keys: {
          type: 'inline',
          keys: [{ key_from_env: VALID_KEY_ENV, subject: SUBJECT, scopes: ['read'] }],
        },
      } satisfies ClientAuthGateConfig,
    };
    transport.setProfileContextProvider(async () => profileContext);

    const logger = (transport as unknown as { logger: { info: ReturnType<typeof vi.fn> } }).logger;
    const infoSpy = vi.spyOn(logger, 'info');

    const req = makeReq(`Bearer ${VALID_KEY}`);
    const res = makeRes();
    await (transport as unknown as { handlePost: (r: unknown, s: unknown) => Promise<void> }).handlePost(req, res);

    expect(res.statusCode).toBe(200);
    const sessionCreatedCall = infoSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('Session created'),
    );
    expect(sessionCreatedCall).toBeDefined();
    const logFields = sessionCreatedCall![1] as Record<string, unknown>;
    expect(logFields['clientSubject']).toBe(SUBJECT);
    expect(logFields['clientAuthType']).toBe('token');
  });
});
