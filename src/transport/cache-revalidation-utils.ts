import type { ResponseContext } from './interceptors.js';
import {
  getHeaderValueCaseInsensitive,
  hasDirective,
  parseCacheControl,
} from './cache-header-utils.js';

export function buildConditionalRequestHeaders(
  cachedResponse: ResponseContext
): Record<string, string> | undefined {
  const conditionalHeaders: Record<string, string> = {};

  const etag = getHeaderValueCaseInsensitive(cachedResponse.headers, 'etag');
  if (etag) {
    conditionalHeaders['If-None-Match'] = etag;
  }

  const lastModified = getHeaderValueCaseInsensitive(cachedResponse.headers, 'last-modified');
  if (lastModified) {
    conditionalHeaders['If-Modified-Since'] = lastModified;
  }

  return Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined;
}

export function cachedResponseRequiresRevalidation(cachedResponse: ResponseContext): boolean {
  const cacheControl = parseCacheControl(
    getHeaderValueCaseInsensitive(cachedResponse.headers, 'cache-control')
  );
  return hasDirective(cacheControl, 'no-cache');
}

export function mergeNotModifiedResponse(
  cachedResponse: ResponseContext,
  notModifiedResponse: ResponseContext
): ResponseContext {
  return {
    status: cachedResponse.status,
    headers: {
      ...cachedResponse.headers,
      ...notModifiedResponse.headers,
    },
    body: structuredClone(cachedResponse.body),
  };
}
