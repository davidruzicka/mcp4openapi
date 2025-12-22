import { describe, it, expect, vi } from 'vitest';
import { addSecurityHeaders } from './security-headers.js';
import { Request, Response } from 'express';

function createMockResponse() {
  const res: any = {
    headers: {} as Record<string, string>,
    setHeader: vi.fn((key: string, value: string) => {
      res.headers[key] = value;
    }),
  };
  return res as Response;
}

function createMockRequest(headers: Record<string, string> = {}, secure = false) {
  return {
    headers,
    secure,
  } as unknown as Request;
}

describe('Security Headers Middleware', () => {
  it('sets standard security headers', () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = vi.fn();

    addSecurityHeaders(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['X-Frame-Options']).toBe('DENY');
    expect(res.headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(res.headers['Permissions-Policy']).toBeDefined();
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('sets HSTS when request is secure', () => {
    const req = createMockRequest({}, true); // secure=true
    const res = createMockResponse();
    const next = vi.fn();

    addSecurityHeaders(req, res, next);

    expect(res.headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('sets HSTS when X-Forwarded-Proto is https', () => {
    const req = createMockRequest({ 'x-forwarded-proto': 'https' }, false);
    const res = createMockResponse();
    const next = vi.fn();

    addSecurityHeaders(req, res, next);

    expect(res.headers['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
  });

  it('does NOT set HSTS when insecure', () => {
    const req = createMockRequest({}, false);
    const res = createMockResponse();
    const next = vi.fn();

    addSecurityHeaders(req, res, next);

    expect(res.headers['Strict-Transport-Security']).toBeUndefined();
  });
});
