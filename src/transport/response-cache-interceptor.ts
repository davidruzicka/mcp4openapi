import type { CachePolicy, CacheStore } from './cache-store.js';
import type { CacheKeyBuilder } from './cache-key-builder.js';
import type { InterceptorFn, RequestContext, ResponseContext } from './interceptors.js';
import { HTTP_STATUS } from '../core/constants.js';

export type CacheEvent =
  | 'hit'
  | 'miss'
  | 'store'
  | 'skip'
  | 'inflight_hit'
  | 'evict_max_entries'
  | 'evict_max_memory';

export type CacheEventRecorder = (event: CacheEvent, operation: string) => void;

export class ResponseCacheInterceptor {
  private inFlight = new Map<string, Promise<ResponseContext>>();

  constructor(
    private readonly policy: CachePolicy,
    private readonly store: CacheStore,
    private readonly keyBuilder: CacheKeyBuilder,
    private readonly onEvent?: CacheEventRecorder
  ) {}

  asInterceptor(): InterceptorFn {
    return async (ctx, next) => {
      const operation = ctx.operationId || 'unknown';

      if (!this.isRequestEligible(ctx)) {
        this.onEvent?.('skip', operation);
        return next();
      }

      const cacheControl = this.getHeaderValueCaseInsensitive(ctx.headers, 'cache-control');
      if (
        this.hasCacheControlDirective(cacheControl, 'no-cache')
        || this.hasCacheControlDirective(cacheControl, 'no-store')
      ) {
        this.onEvent?.('skip', operation);
        return next();
      }

      const cacheKey = this.keyBuilder.build(ctx);
      const cached = this.store.get(cacheKey);
      if (cached) {
        this.onEvent?.('hit', operation);
        return cached;
      }
      this.onEvent?.('miss', operation);

      const existingInFlight = this.inFlight.get(cacheKey);
      if (existingInFlight) {
        this.onEvent?.('inflight_hit', operation);
        return structuredClone(await existingInFlight);
      }

      const requestPromise = (async () => {
        const response = await next();

        if (this.isResponseCacheable(response)) {
          try {
            this.store.set(cacheKey, response, this.policy.ttlSeconds);
            this.onEvent?.('store', operation);
          } catch {
            this.onEvent?.('skip', operation);
          }
        } else {
          this.onEvent?.('skip', operation);
        }

        return response;
      })();

      this.inFlight.set(cacheKey, requestPromise);

      try {
        return structuredClone(await requestPromise);
      } finally {
        this.inFlight.delete(cacheKey);
      }
    };
  }

  private isRequestEligible(ctx: RequestContext): boolean {
    if (!this.policy.methods.has(ctx.method.toUpperCase())) {
      return false;
    }

    return ctx.body === undefined;
  }

  private isResponseCacheable(response: ResponseContext): boolean {
    if (response.status < HTTP_STATUS.OK || response.status >= HTTP_STATUS.MULTIPLE_CHOICES) {
      return false;
    }

    const cacheControl = this.getHeaderValueCaseInsensitive(response.headers, 'cache-control');
    return !this.hasCacheControlDirective(cacheControl, 'no-store');
  }

  private hasCacheControlDirective(cacheControl: string | undefined, directive: string): boolean {
    if (!cacheControl) {
      return false;
    }

    const expected = directive.toLowerCase();
    return cacheControl
      .toLowerCase()
      .split(',')
      .map((token) => token.trim())
      .some((token) => token === expected || token.startsWith(`${expected}=`));
  }

  private getHeaderValueCaseInsensitive(headers: Record<string, string>, headerName: string): string | undefined {
    const target = headerName.toLowerCase();
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === target) {
        return value;
      }
    }
    return undefined;
  }
}
