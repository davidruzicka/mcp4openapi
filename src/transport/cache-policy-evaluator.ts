import type { CachePolicy } from './cache-store.js';
import type { RequestContext, ResponseContext } from './interceptors.js';
import {
  getDirectiveValue,
  getHeaderValueCaseInsensitive,
  hasDirective,
  parseCacheControl,
  parseNonNegativeInteger,
  parseVaryHeader,
} from './cache-header-utils.js';

export type CacheSkipReason =
  | 'req_no_store'
  | 'req_no_cache'
  | 'req_pragma_no_cache'
  | 'req_public_scope_auth'
  | 'resp_non_success'
  | 'resp_no_store'
  | 'resp_no_cache'
  | 'resp_private'
  | 'resp_set_cookie_shared'
  | 'resp_vary_star'
  | 'resp_vary_unsupported'
  | 'resp_ttl_non_positive'
  | 'resp_invalid_directive';

export interface RequestCacheDecision {
  canReadFromCache: boolean;
  canStoreResponse: boolean;
  skipReason?: CacheSkipReason;
  isUnsafeMutationMethod: boolean;
  requiresRevalidation: boolean;
}

export interface ResponseCacheDecision {
  cacheable: boolean;
  ttlSeconds?: number;
  skipReason?: CacheSkipReason;
  requiresRevalidation?: boolean;
}

interface EvaluateRequestInput {
  ctx: RequestContext;
  policy: CachePolicy;
  sensitiveHeaders: Set<string>;
}

interface EvaluateResponseInput {
  response: ResponseContext;
  policy: CachePolicy;
  nowMs?: number;
}

const UNSAFE_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function evaluateRequestCacheDecision(input: EvaluateRequestInput): RequestCacheDecision {
  const method = input.ctx.method.toUpperCase();
  const isUnsafeMutationMethod = UNSAFE_MUTATION_METHODS.has(method);

  if (!input.policy.methods.has(method)) {
    return {
      canReadFromCache: false,
      canStoreResponse: false,
      isUnsafeMutationMethod,
      requiresRevalidation: false,
    };
  }

  if (input.ctx.body !== undefined) {
    return {
      canReadFromCache: false,
      canStoreResponse: false,
      isUnsafeMutationMethod,
      requiresRevalidation: false,
    };
  }

  const cacheControl = parseCacheControl(
    getHeaderValueCaseInsensitive(input.ctx.headers, 'cache-control')
  );

  if (hasDirective(cacheControl, 'no-store')) {
    return {
      canReadFromCache: false,
      canStoreResponse: false,
      skipReason: 'req_no_store',
      isUnsafeMutationMethod,
      requiresRevalidation: false,
    };
  }

  if (hasDirective(cacheControl, 'no-cache')) {
    return {
      canReadFromCache: true,
      canStoreResponse: true,
      isUnsafeMutationMethod,
      requiresRevalidation: true,
    };
  }

  const pragma = getHeaderValueCaseInsensitive(input.ctx.headers, 'pragma');
  if (pragma?.toLowerCase().split(',').map((v) => v.trim()).includes('no-cache')) {
    return {
      canReadFromCache: true,
      canStoreResponse: true,
      isUnsafeMutationMethod,
      requiresRevalidation: true,
    };
  }

  if (input.policy.scope === 'public' && hasSensitiveHeaders(input.ctx.headers, input.sensitiveHeaders)) {
    return {
      canReadFromCache: false,
      canStoreResponse: false,
      skipReason: 'req_public_scope_auth',
      isUnsafeMutationMethod,
      requiresRevalidation: false,
    };
  }

  return {
    canReadFromCache: true,
    canStoreResponse: true,
    isUnsafeMutationMethod,
    requiresRevalidation: false,
  };
}

export function evaluateResponseCacheDecision(input: EvaluateResponseInput): ResponseCacheDecision {
  const { response, policy } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (response.status < 200 || response.status >= 300) {
    return { cacheable: false, skipReason: 'resp_non_success' };
  }

  const cacheControl = parseCacheControl(
    getHeaderValueCaseInsensitive(response.headers, 'cache-control')
  );
  if (hasDirective(cacheControl, 'no-store')) {
    return { cacheable: false, skipReason: 'resp_no_store' };
  }
  const requiresRevalidation = hasDirective(cacheControl, 'no-cache');

  if (policy.scope === 'public') {
    if (hasDirective(cacheControl, 'private')) {
      return { cacheable: false, skipReason: 'resp_private' };
    }
    if (getHeaderValueCaseInsensitive(response.headers, 'set-cookie')) {
      return { cacheable: false, skipReason: 'resp_set_cookie_shared' };
    }
  }

  const vary = parseVaryHeader(getHeaderValueCaseInsensitive(response.headers, 'vary'));
  if (vary.star) {
    return { cacheable: false, skipReason: 'resp_vary_star' };
  }
  for (const header of vary.headers) {
    if (!policy.varyHeaders.has(header)) {
      return { cacheable: false, skipReason: 'resp_vary_unsupported' };
    }
  }

  const ttlSeconds = resolveTtlSeconds(response.headers, cacheControl, policy, nowMs);
  if (ttlSeconds === 'invalid') {
    return { cacheable: false, skipReason: 'resp_invalid_directive' };
  }
  if (requiresRevalidation && !hasRevalidationValidators(response.headers)) {
    return { cacheable: false, skipReason: 'resp_no_cache' };
  }

  if (!requiresRevalidation && ttlSeconds <= 0) {
    return { cacheable: false, skipReason: 'resp_ttl_non_positive' };
  }

  const retentionTtlSeconds = ttlSeconds <= 0 ? policy.ttlSeconds : ttlSeconds;
  return {
    cacheable: true,
    ttlSeconds: retentionTtlSeconds,
    ...(requiresRevalidation ? { requiresRevalidation: true } : {}),
  };
}

type TtlResolution = number | 'invalid';

function resolveTtlSeconds(
  headers: Record<string, string>,
  directives: ReturnType<typeof parseCacheControl>,
  policy: CachePolicy,
  nowMs: number
): TtlResolution {
  const maxAgeDirective = selectAgeDirective(directives, policy.scope === 'public');
  if (maxAgeDirective !== undefined) {
    const parsed = parseNonNegativeInteger(maxAgeDirective);
    if (parsed === undefined) {
      return 'invalid';
    }
    return parsed;
  }

  const expiresTtl = resolveExpiresBasedTtl(headers, nowMs);
  if (expiresTtl !== undefined) {
    return expiresTtl;
  }

  return policy.ttlSeconds;
}

function selectAgeDirective(
  directives: ReturnType<typeof parseCacheControl>,
  sharedCache: boolean
): string | undefined {
  if (sharedCache) {
    const sMaxAge = getDirectiveValue(directives, 's-maxage');
    if (typeof sMaxAge === 'string') {
      return sMaxAge;
    }
    if (sMaxAge === true) {
      return '';
    }
  }

  const maxAge = getDirectiveValue(directives, 'max-age');
  if (typeof maxAge === 'string') {
    return maxAge;
  }
  if (maxAge === true) {
    return '';
  }

  return undefined;
}

function resolveExpiresBasedTtl(
  headers: Record<string, string>,
  nowMs: number
): number | undefined {
  const expires = getHeaderValueCaseInsensitive(headers, 'expires');
  if (!expires) {
    return undefined;
  }

  const expiresMs = Date.parse(expires);
  if (!Number.isFinite(expiresMs)) {
    return undefined;
  }

  const dateHeader = getHeaderValueCaseInsensitive(headers, 'date');
  const dateMs = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  const referenceMs = Number.isFinite(dateMs) ? dateMs : nowMs;

  const ageHeader = getHeaderValueCaseInsensitive(headers, 'age');
  const ageSeconds = ageHeader ? parseNonNegativeInteger(ageHeader) : undefined;
  if (ageHeader && ageSeconds === undefined) {
    return undefined;
  }

  const remainingMs = expiresMs - referenceMs - (ageSeconds ?? 0) * 1000;
  return Math.floor(remainingMs / 1000);
}

function hasSensitiveHeaders(headers: Record<string, string>, sensitiveHeaders: Set<string>): boolean {
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!headerValue) {
      continue;
    }
    if (sensitiveHeaders.has(headerName.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function hasRevalidationValidators(headers: Record<string, string>): boolean {
  return Boolean(
    getHeaderValueCaseInsensitive(headers, 'etag')
    || getHeaderValueCaseInsensitive(headers, 'last-modified')
  );
}
