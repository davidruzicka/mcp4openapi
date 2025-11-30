import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    testTimeout: 30000, // 30s max per test
    hookTimeout: 10000, // 10s max for beforeEach/afterEach
    teardownTimeout: 5000, // 5s max for cleanup
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
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './junit.xml',
    },
  },
});
