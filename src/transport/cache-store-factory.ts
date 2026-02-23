import { ConfigurationError } from '../core/errors.js';
import type { CachePolicy, CacheStore, CacheStoreFactoryOptions } from './cache-store.js';
import { InMemoryCacheStore } from './in-memory-cache-store.js';

type StoreFactory = (policy: CachePolicy, options: CacheStoreFactoryOptions) => CacheStore;

const STORE_FACTORIES: Record<CachePolicy['backend'], StoreFactory> = {
  memory: (policy, options) => new InMemoryCacheStore({
    maxEntries: policy.maxEntries,
    maxMemoryBytes: policy.maxMemoryBytes,
    onEvict: options.onEvict,
  }),
  redis: () => {
    throw new ConfigurationError('cache.backend=redis is not implemented yet. Use cache.backend=memory.');
  },
};

export class CacheStoreFactory {
  static create(policy: CachePolicy, options: CacheStoreFactoryOptions = {}): CacheStore {
    const factory = STORE_FACTORIES[policy.backend];
    if (!factory) {
      throw new ConfigurationError(`Unsupported cache backend: ${policy.backend}`);
    }

    return factory(policy, options);
  }
}
