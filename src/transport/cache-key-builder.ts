import { createHash } from 'node:crypto';
import type { CachePolicy } from './cache-store.js';
import type { RequestContext } from './interceptors.js';

export class CacheKeyBuilder {
  constructor(
    private readonly policy: CachePolicy,
    private readonly sensitiveHeaders: Set<string>,
    private readonly sessionPartitionId: string
  ) {}

  build(ctx: RequestContext): string {
    const url = new URL(ctx.url);
    const sortedQueryEntries = [...url.searchParams.entries()]
      .map((entry, originalIndex) => ({ entry, originalIndex }))
      .sort((left, right) => {
        const keyDiff = left.entry[0].localeCompare(right.entry[0]);
        if (keyDiff !== 0) {
          return keyDiff;
        }
        return left.originalIndex - right.originalIndex;
      })
      .map(({ entry }) => entry);
    const canonicalQuery = new URLSearchParams(sortedQueryEntries).toString();
    const canonicalUrl = `${url.origin}${url.pathname}${canonicalQuery ? `?${canonicalQuery}` : ''}`;

    const variedHeaders = Object.entries(ctx.headers)
      .filter(([name]) => this.policy.varyHeaders.has(name.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right));

    const sensitiveHeaderEntries = Object.entries(ctx.headers)
      .filter(([name]) => this.sensitiveHeaders.has(name.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right));

    const partition = this.resolvePartition(ctx, sensitiveHeaderEntries);

    return createHash('sha256').update(JSON.stringify({
      method: ctx.method.toUpperCase(),
      operationId: ctx.operationId || '',
      url: canonicalUrl,
      variedHeaders,
      partition,
    })).digest('hex');
  }

  private resolvePartition(
    ctx: RequestContext,
    sensitiveHeaderEntries: [string, string][]
  ): string {
    if (this.policy.scope === 'public') {
      return 'public';
    }

    if (this.policy.scope === 'session') {
      return `session:${this.sessionPartitionId}`;
    }

    return createHash('sha256').update(JSON.stringify({
      authHeaders: sensitiveHeaderEntries,
      method: ctx.method.toUpperCase(),
      operationId: ctx.operationId || '',
    })).digest('hex');
  }
}
