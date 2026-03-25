# Testing Patterns

**Analysis Date:** 2026-03-25

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts` (for unit/integration tests), `vitest.e2e.config.ts` (for e2e tests)

**Assertion Library:**
- Built-in Vitest assertions with `expect()`

**Run Commands:**
```bash
npm run test              # Run all tests (typecheck + unit/integration)
npm test                  # Alias for above
npm run test:unit        # Unit and integration tests only (no e2e)
npm run test:e2e         # E2E tests only (requires build first)
npm run test:all         # Unit + e2e
npm run test:ui          # Interactive test UI
npm run coverage         # Generate coverage report
npm run lint             # Run ESLint
npm run typecheck        # TypeScript strict check
```

## Test File Organization

**Location:**
- Co-located with source: `src/{domain}/{feature}.test.ts` alongside `src/{domain}/{feature}.ts`
- Integration tests: `src/testing/*.test.ts` for cross-module tests
- E2E tests: `tests/e2e/*.test.ts` for end-to-end scenarios
- Test utilities: `src/testing/` for mock servers, fixtures, and helpers

**Naming:**
- Test file: `{source}.test.ts` (e.g., `errors.test.ts` for `errors.ts`)
- Test suite: `describe('{Class/Function Name}', ...)`
- Test case: `it('{behavior description}', ...)`

**Example structure:**
```
src/core/
├── errors.ts
├── errors.test.ts        # Tests for errors.ts
├── logger.ts
└── logger.test.ts        # Tests for logger.ts
```

## Test Structure

**Suite Organization:**
- One `describe()` block per class or module
- Nested describe blocks for related functionality groups
- One `it()` per behavior (not one per assertion)

**Pattern:**
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ValidationError, ParameterError } from './errors.js';

describe('Error Classes', () => {
  describe('ParameterError', () => {
    it('should format message with param name and reason', () => {
      const error = new ParameterError('userId', 'must be a positive integer');
      expect(error.message).toBe("Invalid parameter 'userId': must be a positive integer");
      expect(error.code).toBe('PARAMETER_ERROR');
      expect(error.details).toEqual({ paramName: 'userId', reason: 'must be a positive integer' });
      expect(error.name).toBe('ParameterError');
    });
  });
});
```

**Setup and teardown:**
```typescript
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Run before each test
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Run after each test - cleanup
  consoleErrorSpy.mockRestore();
  delete process.env.MCP4_LOG_LEVEL;
});
```

**Timeouts:**
- Default test timeout: 30s
- Hook timeout (beforeEach/afterEach): 10s
- Teardown timeout: 5s
- Set custom timeout: `it('slow test', async () => { ... }, 60000)`

## Mocking

**Framework:** Vitest mocking via `vi` module

**Patterns - Spying:**
```typescript
// Spy on and mock a function
const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
logger.info('message', { data });
expect(spy).toHaveBeenCalledWith(expect.stringMatching(/INFO:/));
spy.mockRestore();
```

**Patterns - Mocking modules:**
```typescript
// Mock entire module
vi.mock('../core/logger.js', () => ({
  ConsoleLogger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    error: vi.fn(),
  })),
}));
```

**Patterns - Environment variables:**
```typescript
beforeEach(() => {
  process.env.MCP4_LOG_LEVEL = 'DEBUG';
});

afterEach(() => {
  delete process.env.MCP4_LOG_LEVEL;
});
```

**What to Mock:**
- External dependencies: logger, HTTP clients, file system operations
- External services: OAuth providers (use mock HTTP server for integration tests)
- Time-dependent operations: via `vi.useFakeTimers()` and `vi.setSystemTime()`
- Console methods: for logging assertions

**What NOT to Mock:**
- Internal business logic (test actual implementation)
- Error handling paths (test real error behavior)
- Validation logic (test real validation rules)
- Type constructors (test real constructors)

## Fixtures and Factories

**Test Data Patterns:**

```typescript
// Simple object fixture
const operation: OperationInfo = {
  operationId: 'test',
  method: 'POST',
  path: '/test',
  parameters: [],
};

// With request body schema
const operationWithSchema: OperationInfo = {
  operationId: 'test',
  method: 'POST',
  path: '/test',
  parameters: [],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    },
  },
};

// Type-based fixtures (for profile-related tests)
const authConfig: AuthInterceptor = {
  type: 'bearer',
  value_from_env: 'MCP4_API_TOKEN'
};
```

**Location:**
- Inline in test files for simple fixtures
- `src/testing/` directory for shared fixtures and utilities
- Fixtures that are profile/schema related go in `src/testing/` (no separate fixtures directory)

## Coverage

**Requirements:** Not explicitly enforced via gates, but enabled for analysis

**View Coverage:**
```bash
npm run coverage          # Generate coverage report
# Reports in: coverage/html/index.html (HTML), coverage/lcov.info (LCOV)
```

**Excluded from coverage:**
- Type definitions (`src/types/**`)
- Barrel/export files (`src/lib.ts`)
- CLI entry point (`src/index.ts`) - tested indirectly
- Test utilities (`src/testing/**`)
- Scripts (`scripts/**`)
- E2E tests (`tests/**`)

## Test Types

**Unit Tests:**
- Scope: Single function or class
- Location: `src/{domain}/{feature}.test.ts`
- Approach: Test one behavior per test, mock dependencies, verify assertions
- Example: `src/core/errors.test.ts` tests error class constructors and helper functions
- Example: `src/core/logger.test.ts` tests ConsoleLogger and JsonLogger behavior with mocked console

**Integration Tests:**
- Scope: Multiple modules working together
- Location: `src/testing/*.test.ts`
- Approach: Test workflows across module boundaries, use real implementations where possible
- Example: `src/testing/oauth-initialization.test.ts` tests OAuth provider initialization with real ExternalOAuthProvider
- Example: `src/testing/profile-test-coverage.test.ts` tests profile loading and validation end-to-end

**E2E Tests:**
- Scope: Full server startup and HTTP transport
- Framework: Vitest with custom test utilities
- Location: `tests/e2e/*.test.ts` (separate config: `vitest.e2e.config.ts`)
- Setup: `npm run build` required before running
- Approach: Start server with test profiles, make HTTP requests, verify responses
- Mock external APIs: Use MSW (Mock Service Worker) for API mocking

## Common Patterns

**Async Testing:**
```typescript
// Async function test
it('should load spec from URL', async () => {
  const parser = new OpenAPIParser();
  await parser.load('https://api.example.com/openapi.json');
  expect(parser.operations).toBeDefined();
});

// Promise-based assertion
it('should reject on invalid spec', () => {
  const parser = new OpenAPIParser();
  return expect(parser.load('invalid.json')).rejects.toThrow(ConfigurationError);
});
```

**Error Testing:**
```typescript
// Test error creation and properties
it('should create error with details', () => {
  const error = new ValidationError('Invalid input', { field: 'email' });
  expect(error.message).toBe('Invalid input');
  expect(error.code).toBe('VALIDATION_ERROR');
  expect(error.details).toEqual({ field: 'email' });
});

// Test error throwing
it('should throw on invalid parameter', () => {
  expect(() => {
    validateParameter('userId', 'invalid-id');
  }).toThrow(ParameterError);
});

// Test type guards
it('should identify MCPError instances', () => {
  expect(isMCPError(new ValidationError('test'))).toBe(true);
  expect(isMCPError(new Error('plain error'))).toBe(false);
});
```

**Validation Testing Pattern:**
```typescript
// Success case
it('passes when valid', () => {
  const result = validator.validateRequestBody(operation, { name: 'test' });
  expect(result.valid).toBe(true);
});

// Failure case with error details
it('detects type mismatch', () => {
  const result = validator.validateRequestBody(operation, { age: 'not a number' });
  expect(result.valid).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(result.errors![0].path).toBe('age');
  expect(result.errors![0].message).toContain('Expected number');
});
```

**Token Redaction Testing:**
```typescript
it('should redact Authorization header', () => {
  const authConfig: AuthInterceptor = {
    type: 'bearer',
    value_from_env: 'MCP4_API_TOKEN'
  };
  
  const logger = new ConsoleLogger(LogLevel.INFO, authConfig);
  logger.info('Request', { headers: { Authorization: 'Bearer secret-token' } });
  
  expect(consoleErrorSpy).toHaveBeenCalledWith(
    expect.stringMatching(/\[REDACTED\]/)
  );
  expect(consoleErrorSpy).not.toHaveBeenCalledWith(
    expect.stringContaining('secret-token')
  );
});
```

**Spy Usage Pattern:**
```typescript
// Track spy state
const spy = vi.spyOn(Logger, 'debug');
doSomething();
expect(spy).toHaveBeenCalledOnce();
expect(spy).toHaveBeenCalledWith(expect.stringMatching(/pattern/));
expect(spy.mock.calls[0][0]).toBe('expected message');

// Restore after test
spy.mockRestore();
```

**String Matching in Assertions:**
```typescript
// Use regex patterns for flexible matching
expect(output).toMatch(/\[.*\] INFO: test message/);
expect(output).toMatch(/\d{4}-\d{2}-\d{2}T/);  // ISO date

// Use string containment for partial matches
expect(output).toContain('ERROR');
expect(output).toContain('secret-token');
```

## Test Coverage Strategy

**Critical Paths (High Priority):**
- Error class creation and type guards (`src/core/errors.test.ts`)
- Logging behavior and token redaction (`src/core/logger.test.ts`)
- Validation logic (schema, parameter, request body)
- Auth interceptors (all types: bearer, query, custom-header, session-cookie)

**Medium Priority:**
- Utility functions (normalization, escaping, validation utils)
- Configuration loading and validation
- OpenAPI parsing and indexing

**Lower Priority (excluded from coverage):**
- CLI wrappers (tested via integration tests)
- Type definitions (purely structural)
- Barrel files (re-export only)

---

*Testing analysis: 2026-03-25*
