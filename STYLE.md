# STYLE.md

## Purpose

Canonical style and layering rules for MCP4OpenAPI. Prevails over all other style notes.

## 1. General Principles

- Follow TypeScript 5.x and ES2022 conventions.
- Prefer clarity and explicitness over cleverness.
- All validation, business logic, and error handling must reference canonical docs (see AGENTS.md).

## 2. File & Directory Structure

- Source code: `src/`
- Tests: co-located as `*.test.ts` or in `src/testing/` for integration, `tests/e2e/` for E2E.
- Types: `src/types/`
- Profiles: `profiles/{api-name}/`
- Scripts: `scripts/`
- Documentation: `docs/`

## 3. Naming

- Use `camelCase` for variables, functions, and methods.
- Use `PascalCase` for types, classes, and interfaces.
- File names: `kebab-case.ts` for modules, `snake_case.json` for profiles.
- Test files: `{module}.test.ts` next to the source or in `src/testing/`.

## 4. Formatting

- 2 spaces for indentation.
- Use single quotes `'` for strings, except in JSON.
- Always use trailing commas in multiline objects/arrays.
- Prefer `const` over `let` unless reassignment is required.
- No semicolons at end of statements (unless required by parser).

## 5. Imports & Exports

- Use ES module syntax (`import`/`export`).
- Group imports: external modules first, then internal, then types.
- No default exports; always use named exports.

## 6. TypeScript

- Always type function arguments and return values.
- Prefer interfaces for object shapes, types for unions.
- Use `unknown` over `any` where possible.
- Avoid non-null assertions (`!`) unless absolutely necessary.

## 7. Error Handling

- Only use error types defined in `src/errors.ts`.
- Never throw ad-hoc strings or objects.
- All errors must be sanitized for secrets/tokens.

## 8. Layering & Architecture

- No business logic in route/entry files (`index.ts`).
- Keep functions ≤ 40 lines; split logic into smaller helpers/services.
- Validation and transformation logic must be in dedicated modules.
- Never duplicate validation or business rules; always reference canonical docs.

## 9. Comments & Documentation

- All comments in English.
- Use JSDoc for exported functions, classes, and complex logic.
- Document all public APIs and profile fields in `docs/`.

## 10. Tests

- Each new validator must have both success and failure tests.
- No test skipping (`it.skip`/`describe.skip`) in committed code.
- Use fixtures from `src/testing/fixtures.ts` where possible.
