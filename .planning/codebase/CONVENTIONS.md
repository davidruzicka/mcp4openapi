# Coding Conventions

**Analysis Date:** 2026-03-25

## Naming Patterns

**Files:**
- TypeScript source: `camelCase.ts` (e.g., `openapi-parser.ts`, `profile-loader.ts`)
- Test files: `*.test.ts` (co-located with source, e.g., `src/core/errors.test.ts`)
- Class/interface files follow feature naming: `src/{domain}/{feature}.ts`

**Functions:**
- camelCase for all functions: `validateRequestBody`, `generateCorrelationId`, `sanitizeLogMessage`
- Prefix conventions:
  - `is*` for boolean checks: `isMCPError()`, `isSafePropertyName()`
  - `get*` for getters: `getErrorDetails()`
  - `validate*` for validation: `validateRequestBody()`
  - `parse*` for parsers: `parseYaml`
  - `escape*`/`redact*` for security operations: `escapeRegExp()`, `redactHeader()`

**Variables:**
- camelCase for all variables: `schemaCache`, `consoleErrorSpy`, `headerName`
- SCREAMING_SNAKE_CASE for constants and enum values: `FORBIDDEN_PROPERTY_NAMES`, `SESSION_TIMEOUT_MS`, `LogLevel.DEBUG`
- Use descriptive names: `authConfig` not `auth`, `redacted` not `r`
- `_` prefix for unused parameters: `(_error, _context) =>` (ESLint rule enforced)

**Types:**
- PascalCase for all types: `MCPError`, `ValidationError`, `OpenAPIParser`, `AuthInterceptor`
- Suffix conventions:
  - `Error` for error classes: `NetworkError`, `ConfigurationError`
  - `Config` for configuration types: `OAuthConfig`, `SessionCookieConfig`
  - `Validator` for validator classes: `SchemaValidator`, `SSRFValidator`
  - `Interceptor` for middleware/interceptor types: `AuthInterceptor`
- No `I` prefix for interfaces (modern TypeScript convention)

## Code Style

**Formatting:**
- Configured by ESLint (no Prettier in use)
- TypeScript strict mode enabled (`tsconfig.json`: `"strict": true`)
- 2-space indentation (ESLint default)
- Files end with newline (Git convention)

**Linting:**
- Tool: ESLint with TypeScript plugin (`@typescript-eslint/eslint-plugin`)
- Config: `eslint.config.js` (flat config format, ESLint v10+)
- Key rules:
  - `@typescript-eslint/no-unused-vars`: Enforced with `argsIgnorePattern: "^_"`
  - `no-unused-vars`: Scripts allow `__dirname` as exception
  - Test files relax `@typescript-eslint/no-explicit-any` for mocking

**Comments:**
- JSDoc blocks for public functions: describes purpose, parameters, return
- Why-comments for non-obvious design decisions: `// Why: ...` (see `src/core/logger.ts` for examples)
- TODOs with context: Document intended fixes, not just "TODO"
- Security-focused comments: Mark token redaction, SSRF validation, prototype pollution prevention

## Import Organization

**Order:**
1. Node.js built-ins: `import fs from 'fs/promises'`, `import { randomUUID } from 'node:crypto'`
2. Third-party packages: `import { parse as parseYaml } from 'yaml'`, `import type { OpenAPIV3 } from 'openapi-types'`
3. Local types: `import type { Profile, AuthInterceptor } from '../types/profile.js'`
4. Local implementation: `import { MCPError } from '../core/errors.js'`

**Path Aliases:**
- No path aliases configured (explicit relative paths throughout)
- Use relative paths with `.js` extension for ES modules: `import { parse } from '../core/lib.js'`
- Type imports use `import type { ... }` syntax
- Files use:
  - `./` for same directory: `import { Logger } from './logger.js'`
  - `../` for parent levels: `import { Profile } from '../../types/profile.js'`

**Import style:**
- Destructure named exports: `import { ValidationError } from '../core/errors.js'`
- Use `as` for aliasing to avoid conflicts: `import { parse as parseYaml } from 'yaml'`
- Namespace imports for type definitions: `import type { OpenAPIV3 } from 'openapi-types'`

## Error Handling

**Pattern:**
- Always use typed errors from `src/core/errors.ts`: `ValidationError`, `AuthenticationError`, `OperationNotFoundError`, etc.
- Never throw generic `Error` or ad-hoc strings
- Errors include `code` (string) and optional `details` (Record<string, unknown>)

**Example:**
```typescript
// Correct
throw new ParameterError('userId', 'must be a positive integer');
// Or with details
throw new ValidationError('Invalid input', { field: 'email', expected: 'string' });

// Wrong
throw new Error('Invalid parameter');
throw 'Parameter error';
```

**Error checking:**
- Use `isMCPError()` type guard to check if error is typed MCPError
- Call `getErrorDetails()` to extract all details for logging

**Correlation IDs:**
- Generate with `generateCorrelationId()` for error tracking
- Returned in error responses for client debugging

## Logging

**Framework:** `ConsoleLogger` or `JsonLogger` (no external logging library)

**Levels:**
- `LogLevel.DEBUG`: Development details (low-level state, trace info)
- `LogLevel.INFO`: Normal operations (configuration loaded, requests started)
- `LogLevel.WARN`: Degraded behavior (retries, timeouts, non-fatal issues)
- `LogLevel.ERROR`: Failures requiring attention (network errors, validation failures)
- `LogLevel.SILENT`: All logs suppressed

**Configuration:**
- Set via `MCP4_LOG_LEVEL` env var: `debug`, `info`, `warn`, `error`, `silent` (case-insensitive)
- Defaults to `INFO` if not set or invalid

**Usage:**
```typescript
import { ConsoleLogger, LogLevel } from './core/logger.js';

const logger = new ConsoleLogger(LogLevel.INFO);
logger.debug('startup details', { config });
logger.info('request received', { method, path });
logger.warn('retry attempt', { attempt: 2, delay: 1000 });
logger.error('operation failed', error, { operationId });
```

**Security in Logs:**
- Logs automatically redact auth tokens based on profile auth type (bearer/query/custom-header/session-cookie)
- Well-known secrets redacted: `access_token`, `refresh_token`, `client_secret`, `code`, `code_verifier`
- Call `sanitizeLogMessage()` to prevent log injection attacks (escapes control characters, ANSI codes)

## Function Design

**Size:**
- Prefer small focused functions (< 50 lines)
- Extract helper functions for repeated patterns
- One responsibility per function

**Parameters:**
- Use object parameters for > 2 related values: `function validateRequest(operation: OperationInfo, body: unknown)`
- Mark optional with `?`: `authConfig?: AuthInterceptor`
- Use `...rest` for variable arguments only when semantically correct

**Return Values:**
- Return union types for operations with multiple outcomes: `{ valid: true } | { valid: false; errors: ValidationError[] }`
- Use `undefined` for optional values, not `null` (TypeScript convention)
- Use early returns to flatten nesting
- Void functions for side-effect-only operations

**Example pattern:**
```typescript
export function validateRequestBody(
  operation: OperationInfo,
  body: unknown
): { valid: true } | { valid: false; errors: SchemaError[] } {
  if (!operation.requestBody) {
    return { valid: true };
  }

  const errors: SchemaError[] = [];
  // Validation logic...

  return errors.length === 0
    ? { valid: true }
    : { valid: false, errors };
}
```

## Module Design

**Exports:**
- `export class` for classes: `export class OpenAPIParser`
- `export function` for functions: `export function validateRequest()`
- `export type` for types: `export type OperationInfo`
- `export const` for constants (especially enums): `export const LogLevel = { ... }`
- Export specific items, not namespace defaults

**Barrel Files:**
- Used for re-exports: `src/core/index.ts` re-exports public API
- One barrel file per domain: `src/core/index.ts`, `src/validation/index.ts`
- Pattern: `export { Foo } from './foo.js'` (explicit re-exports only)

**Internal vs Public:**
- Internal helpers prefixed with underscore if private to module: `function _normalize()`
- Or keep in same file without export
- Mark internal types with JSDoc comment: `/** @internal */`

## Data-Driven Design

**Over branching chains:**
- Use lookup maps instead of if/else chains
- Example from logger: auth type handled via map, not switch statement

**Constants for configuration:**
- All magic numbers in `src/core/constants.ts`
- Used pattern: `export const TIME = { MS_PER_SECOND: 1000, ... }` as const
- Then reference: `SESSION_TIMEOUT_MS: 30 * TIME.MS_PER_MINUTE`

## Security Patterns

**Input Validation:**
- Validate property names: `isSafePropertyName(name)` prevents prototype pollution
- Escape regex special chars: `escapeRegExp(str)` prevents ReDoS
- Always validate URLs: `SSRFValidator` prevents SSRF attacks
- Validate auth tokens before using them in requests

**Output Escaping:**
- HTML content escaped: `escapeHtml()` from `escape-html` package
- Sensitive values redacted in logs (automatic per auth type)

**Token Handling:**
- Never log raw tokens (automatic via `redactSensitiveContext()`)
- Mark token fields well-known: `access_token`, `refresh_token`, etc.
- Use env vars for token storage, never hardcode

---

*Convention analysis: 2026-03-25*
