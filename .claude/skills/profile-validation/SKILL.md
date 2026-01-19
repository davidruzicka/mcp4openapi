---
name: profile-validation
description: Validate profile files against the schema and OpenAPI operations. Use when creating or changing profiles or when validation errors appear.
---

# Profile validation

## When to use
- Creating or updating profile JSON files
- Investigating validation errors
- Ensuring OpenAPI operations exist for tools

## Steps
1. Validate structure only:
   - `npm run validate -- profiles/my-profile.json`
2. Validate structure plus OpenAPI operations:
   - `npm run validate -- profiles/my-profile.json openapi.yaml`
3. Ensure parameter aliases are defined for generic path params.
4. Ensure metadata parameters are marked and not sent to the API.

## Checks and tests
- Run `npm run typecheck` before finishing.
- Run `npm test` after fixing validation errors.

## Notes
- Operation lookup is strict. If an operation is missing, update the spec or profile.
