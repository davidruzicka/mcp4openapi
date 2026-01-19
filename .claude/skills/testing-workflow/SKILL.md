---
name: testing-workflow
description: Run the right tests for changes and keep coverage expectations. Use when modifying code or tests, or when debugging failures.
---

# Testing workflow

## When to use
- After any code change
- When adding new validators or features
- When fixing test failures

## Steps
1. Run `npm run typecheck` before finishing.
2. Run `npm test` for unit and integration tests.
3. Use `npm test -- -t "pattern"` for focused changes.
4. For coverage, run `npm test -- --coverage`.
5. For diff coverage in branch, run `node scripts/check-diff-coverage.js`.

## Notes
- New validators require both success and failure tests.
- E2E tests live in `tests/e2e/`.
