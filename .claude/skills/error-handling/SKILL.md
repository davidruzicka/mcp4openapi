---
name: error-handling
description: Use typed errors and consistent error handling across the codebase. Use when adding new error cases or adjusting error behavior.
---

# Error handling

## When to use
- Introducing new error cases
- Refactoring error messages or handling
- Updating error serialization

## Steps
1. Add or update error types in src/errors.ts.
2. Use typed errors in feature code, avoid ad-hoc strings.
3. Ensure correlation ids are included in client-facing errors.
4. Sanitize tokens and secrets in error messages.
5. Update tests in src/errors.test.ts and affected feature tests.

## Checks and tests
- Run `npm run typecheck` before finishing.
- Run `npm test`.

## Notes
- Keep error handling consistent with canonical docs.
