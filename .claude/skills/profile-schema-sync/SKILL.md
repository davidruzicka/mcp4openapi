---
name: profile-schema-sync
description: Update profile structure and keep TypeScript types, generated Zod schemas, and JSON Schema in sync. Use when adding or changing profile fields or validation rules.
---

# Profile schema sync

## When to use
- Adding or changing any profile field
- Adjusting validation rules for profiles
- Updating profile-related documentation or tests

## Steps
1. Update the profile types in src/types/profile.ts.
2. Run npm run generate-schemas to refresh src/generated-schemas.ts.
3. Manually update profile-schema.json to match the TypeScript types.
4. Update profile validation tests in src/profile-loader.test.ts.
5. Update docs/PROFILE-GUIDE.md if the change is user-facing.
6. Remove any completed item from TODO.md.

## Checks and tests
- Run `npm run typecheck` before finishing.
- Run `npm test`.
- Run `npm run validate` for any changed profile.

## Notes
- Missing fields in generated schemas break runtime validation.
- Do not duplicate validation rules that already exist in canonical docs.
