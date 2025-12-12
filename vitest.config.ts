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
      exclude: [
        // Default excludes
        'vitest.config.ts',
        'vitest.e2e.config.ts',
        'node_modules/**',
        'dist/**',
        'coverage/**',
        '**/*.test.ts',
        '**/*.d.ts',
        // Type definitions only
        'src/types/**',
        // Export module only
        'src/lib.ts',
        // CLI entry point (tested indirectly via integration tests)
        'src/index.ts',
        // Scripts (not part of runtime code)
        'scripts/**',
        // Test utilities
        'src/testing/**',
        // E2E test utilities
        'tests/**',
      ],
    },
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './junit.xml',
    },
  },
});
