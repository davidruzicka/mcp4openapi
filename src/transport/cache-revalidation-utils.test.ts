import { describe, expect, it } from 'vitest';
import type { ResponseContext } from './interceptors.js';
import {
  buildConditionalRequestHeaders,
  cachedResponseRequiresRevalidation,
  mergeNotModifiedResponse,
} from './cache-revalidation-utils.js';

function createResponse(headers: Record<string, string>, body: unknown = { ok: true }): ResponseContext {
  return {
    status: 200,
    headers,
    body,
  };
}

describe('cache-revalidation-utils', () => {
  it('builds conditional headers from ETag and Last-Modified', () => {
    const headers = buildConditionalRequestHeaders(
      createResponse({
        ETag: '"abc"',
        'Last-Modified': 'Tue, 24 Feb 2026 00:00:00 GMT',
      })
    );

    expect(headers).toEqual({
      'If-None-Match': '"abc"',
      'If-Modified-Since': 'Tue, 24 Feb 2026 00:00:00 GMT',
    });
  });

  it('returns undefined when validators are missing', () => {
    const headers = buildConditionalRequestHeaders(createResponse({ 'Cache-Control': 'max-age=60' }));
    expect(headers).toBeUndefined();
  });

  it('detects no-cache in cached response', () => {
    expect(
      cachedResponseRequiresRevalidation(createResponse({ 'Cache-Control': 'public, no-cache' }))
    ).toBe(true);
    expect(
      cachedResponseRequiresRevalidation(createResponse({ 'Cache-Control': 'public, max-age=60' }))
    ).toBe(false);
  });

  it('merges 304 headers into cached response and keeps cached body', () => {
    const cached = createResponse(
      {
        'Content-Type': 'application/json',
        ETag: '"old"',
        'Cache-Control': 'no-cache',
      },
      { value: 1 }
    );
    const notModified: ResponseContext = {
      status: 304,
      headers: {
        ETag: '"new"',
        Date: 'Tue, 24 Feb 2026 00:01:00 GMT',
      },
      body: '',
    };

    const merged = mergeNotModifiedResponse(cached, notModified);
    expect(merged.status).toBe(200);
    expect(merged.body).toEqual({ value: 1 });
    expect(merged.headers).toMatchObject({
      'Content-Type': 'application/json',
      ETag: '"new"',
      Date: 'Tue, 24 Feb 2026 00:01:00 GMT',
      'Cache-Control': 'no-cache',
    });
  });
});
