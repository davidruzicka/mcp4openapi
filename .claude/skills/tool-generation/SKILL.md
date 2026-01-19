---
name: tool-generation
description: Add or adjust MCP tool generation from OpenAPI, including composite tools. Use when changing tool definitions, OpenAPI parsing, or composite execution.
---

# Tool generation

## When to use
- Changing tool generation logic or output
- Adjusting OpenAPI parsing or operation lookup
- Adding or changing composite tools

## Steps
1. Update the relevant types in `src/types/profile.ts` if tool definitions change.
2. Modify `src/tool-generator.ts` for tool generation behavior.
3. Modify `src/openapi-parser.ts` for operation lookup or parsing.
4. For composite tools, update `src/composite-executor.ts` and ensure steps use store_as and depends_on correctly.
5. Update tests in `src/tool-generator.test.ts` and `src/composite-executor.test.ts`.
## Checks and tests
- Run `npm run typecheck` before finishing.
- Run `npm test` with a targeted pattern if needed.

## Notes
- Composite tools should use steps with `store_as` and `depends_on`.
- Use `partial_results` only if callers can handle partial output.
