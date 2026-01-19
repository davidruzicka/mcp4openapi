---
name: repo-workflow
description: Follow repository workflow rules and avoid duplicated logic. Use when starting any change to ensure consistent process and documentation.
---

# Repository workflow

## When to use
- Starting any change in this repo
- Planning a multi-file change
- Updating documentation or TODO items

## Steps
1. Check canonical sources for rules before implementing.
2. Avoid duplicating validation or business rules.
3. Keep schema systems in sync when profile types change.
4. Remove completed items from TODO.md.
5. Update user-facing docs when behavior changes.

## Checks and tests
- Run `npm run typecheck` before finishing.
- Run `npm test` for any code change.

## Notes
- Use ASCII hyphen minus in comments and docs.
- Do not recommend HSTS headers in this repo.
