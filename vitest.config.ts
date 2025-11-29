import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30s max per test
    hookTimeout: 10000, // 10s max for beforeEach/afterEach
    teardownTimeout: 5000, // 5s max for cleanup
    forceExit: true, // Force exit after tests complete (prevents zombie processes)
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 4,
        isolate: true, // Isolate each test file
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
