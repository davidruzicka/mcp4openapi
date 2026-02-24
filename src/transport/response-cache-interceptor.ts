import type { CachePolicy, CacheStore } from './cache-store.js';
import type { CacheKeyBuilder } from './cache-key-builder.js';
import type { InterceptorFn, RequestContext, ResponseContext } from './interceptors.js';
import {
  type CacheSkipReason,
  evaluateRequestCacheDecision,
  evaluateResponseCacheDecision,
} from './cache-policy-evaluator.js';

export type CacheEvent =
  | 'hit'
  | 'miss'
  | 'store'
  | 'skip'
  | 'skip_req_no_store'
  | 'skip_req_no_cache'
  | 'skip_req_pragma_no_cache'
  | 'skip_req_public_scope_auth'
  | 'skip_resp_no_store'
  | 'skip_resp_no_cache'
  | 'skip_resp_private'
  | 'skip_resp_set_cookie_shared'
  | 'skip_resp_vary'
  | 'skip_resp_ttl'
  | 'skip_resp_invalid_directive'
  | 'skip_resp_non_success'
  | 'inflight_hit'
  | 'invalidate_unsafe_method'
  | 'evict_max_entries'
  | 'evict_max_memory';

export type CacheEventRecorder = (event: CacheEvent, operation: string) => void;

export class ResponseCacheInterceptor {
  private inFlight = new Map<string, Promise<ResponseContext>>();

  constructor(
    private readonly policy: CachePolicy,
    private readonly store: CacheStore,
    private readonly keyBuilder: CacheKeyBuilder,
    private readonly sensitiveHeaders: Set<string>,
    private readonly onEvent?: CacheEventRecorder
  ) {}

  asInterceptor(): InterceptorFn {
    return async (ctx, next) => {
      const operation = ctx.operationId || 'unknown';
      const requestDecision = evaluateRequestCacheDecision({
        ctx,
        policy: this.policy,
        sensitiveHeaders: this.sensitiveHeaders,
      });

      if (!requestDecision.canReadFromCache) {
        this.recordSkipReason(requestDecision.skipReason, operation);
        const response = await next();
        this.invalidateAfterUnsafeMutation(ctx, response, requestDecision, operation);
        return response;
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

        if (requestDecision.canStoreResponse) {
          const responseDecision = evaluateResponseCacheDecision({
            response,
            policy: this.policy,
          });

          if (responseDecision.cacheable && responseDecision.ttlSeconds !== undefined) {
            try {
              this.store.set(cacheKey, response, responseDecision.ttlSeconds);
              this.onEvent?.('store', operation);
            } catch {
              this.onEvent?.('skip', operation);
            }
          } else {
            this.recordSkipReason(responseDecision.skipReason, operation);
          }
        }

        this.invalidateAfterUnsafeMutation(ctx, response, requestDecision, operation);
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

  private invalidateAfterUnsafeMutation(
    ctx: RequestContext,
    response: ResponseContext,
    decision: { isUnsafeMutationMethod: boolean },
    operation: string
  ): void {
    if (!decision.isUnsafeMutationMethod) {
      return;
    }

    const method = ctx.method.toUpperCase();
    if (response.status < 200 || response.status >= 300) {
      return;
    }

    this.store.clear();
    this.inFlight.clear();
    this.onEvent?.('invalidate_unsafe_method', `${operation}:${method}`);
  }

  private recordSkipReason(reason: CacheSkipReason | undefined, operation: string): void {
    if (!reason) {
      this.onEvent?.('skip', operation);
      return;
    }

    const reasonToEvent: Record<CacheSkipReason, CacheEvent> = {
      req_no_store: 'skip_req_no_store',
      req_no_cache: 'skip_req_no_cache',
      req_pragma_no_cache: 'skip_req_pragma_no_cache',
      req_public_scope_auth: 'skip_req_public_scope_auth',
      resp_non_success: 'skip_resp_non_success',
      resp_no_store: 'skip_resp_no_store',
      resp_no_cache: 'skip_resp_no_cache',
      resp_private: 'skip_resp_private',
      resp_set_cookie_shared: 'skip_resp_set_cookie_shared',
      resp_vary_star: 'skip_resp_vary',
      resp_vary_unsupported: 'skip_resp_vary',
      resp_ttl_non_positive: 'skip_resp_ttl',
      resp_invalid_directive: 'skip_resp_invalid_directive',
    };

    const mappedEvent = reasonToEvent[reason];
    if (mappedEvent) {
      this.onEvent?.(mappedEvent, operation);
    } else {
      this.onEvent?.('skip', operation);
    }
  }
}
