import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { OAuthGrantRouter } from './oauth-grant-router.js';
import { ValidationError } from '../core/errors.js';

function makeReq(body: Record<string, unknown>): Request {
  return { body } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      res.body = payload;
      return res;
    }),
  };
  return res as unknown as Response;
}

describe('OAuthGrantRouter', () => {
  it('ignores unrecognized request parameters (RFC 6749 3.2)', async () => {
    const router = new OAuthGrantRouter();
    const handler = vi.fn(async () => {});
    router.register('authorization_code', {
      required: ['code'],
      optional: ['redirect_uri'],
      handler,
    });

    const req = makeReq({
      grant_type: 'authorization_code',
      code: 'abc',
      // Unknown extras that older clients / proxies may attach:
      audience: 'https://api.example.com',
      foo: 'bar',
    });
    const res = makeRes();

    await router.route(req, res);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects a grant-defining parameter that belongs to a different grant (grant confusion)', async () => {
    const router = new OAuthGrantRouter();
    const jwtHandler = vi.fn(async () => {});
    router.register('authorization_code', {
      required: ['code'],
      optional: [],
      handler: vi.fn(async () => {}),
    });
    router.register('urn:ietf:params:oauth:grant-type:jwt-bearer', {
      required: ['assertion'],
      optional: ['client_id'],
      handler: jwtHandler,
    });

    // `code` is another grant's required parameter, not valid for jwt-bearer.
    await expect(
      router.route(
        makeReq({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'a', code: 'x' }),
        makeRes(),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(jwtHandler).not.toHaveBeenCalled();
  });

  it('still rejects a missing required parameter', async () => {
    const router = new OAuthGrantRouter();
    router.register('authorization_code', {
      required: ['code'],
      optional: [],
      handler: vi.fn(async () => {}),
    });

    await expect(router.route(makeReq({ grant_type: 'authorization_code' }), makeRes()))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a missing grant_type', async () => {
    const router = new OAuthGrantRouter();
    await expect(router.route(makeReq({}), makeRes())).rejects.toBeInstanceOf(ValidationError);
  });

  it('responds unsupported_grant_type for an unknown grant', async () => {
    const router = new OAuthGrantRouter();
    const res = makeRes();
    await router.route(makeReq({ grant_type: 'password' }), res);
    expect(res.statusCode).toBe(400);
    expect((res as unknown as { body: { error: string } }).body.error).toBe('unsupported_grant_type');
  });
});
