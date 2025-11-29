# Copilot Instructions for mcp4openapi

## Architecture Overview

MCP server that transforms OpenAPI specs into MCP tools via JSON profiles. Key flow:
```
index.ts (CLI) → MCPServer → OpenAPIParser → ProfileLoader → ToolGenerator → InterceptorChain
                                                              ↓
                                               CompositeExecutor (multi-step API calls)
```

**Core concept**: Profiles aggregate multiple OpenAPI operations into single MCP tools (e.g., `manage_project_badges` → 5 CRUD operations) to reduce LLM context pollution.

## Critical: Schema Synchronization

When modifying profile structure (`src/types/profile.ts`):
1. **Edit** `src/types/profile.ts` (source of truth)
2. **Run** `npm run generate-schemas` (auto-generates Zod in `src/generated-schemas.ts`)
3. **Update** `profile-schema.json` manually (for IDE autocomplete)
4. **Test** with `npm test`

⚠️ Zod strips unknown properties silently - missing field in generated schema = feature broken at runtime.

## Development Commands

```bash
npm run build          # Runs generate-schemas + tsc
npm test               # Runs typecheck + vitest
npm run validate       # Validates profiles against schema + OpenAPI spec
npm start              # Runs built server (needs MCP4_* env vars)
```

## Test Patterns

- Unit tests: `src/*.test.ts` (co-located with source)
- Integration tests: `src/testing/*.test.ts`
- Mock server: `src/testing/mock-gitlab-server.ts` uses MSW
- Fixtures: `src/testing/fixtures.ts`

Tests use Vitest. Run specific test: `npm test -- --grep "pattern"`

## Key Patterns

### Profile Configuration
See `profiles/gitlab/developer-profile.json` for complete example:
- `operations`: Maps action names to OpenAPI operationIds
- `metadata_params`: Parameters controlling tool behavior (not sent to API)
- `required_for`: Conditional parameter requirements per action
- `response_fields`: Filter response for LLM brevity

### Interceptor Chain (`src/interceptors.ts`)
Order: auth → rate-limit → retry → fetch. Each interceptor is independently testable.

### Composite Tools (`composite-executor.ts`)
Chain API calls with `steps[]` and `store_as` for result aggregation. Supports `partial_results: true`.

### Error Handling (`src/errors.ts`)
Use typed errors: `ConfigurationError`, `ValidationError`, `AuthenticationError`, etc. All include correlation IDs.

## Environment Variables

Required: `MCP4_OPENAPI_SPEC_PATH`, `MCP4_API_TOKEN` (for authenticated APIs)
Transport: `MCP4_TRANSPORT=stdio|http`
See `README.md` for full list.

## File Naming

- Source: `src/{feature}.ts` with `src/{feature}.test.ts`
- Types: `src/types/{domain}.ts`
- Testing utilities: `src/testing/`

## PR Checklist

- [ ] `npm test` passes
- [ ] Schema changes: ran `npm run generate-schemas` and updated `profile-schema.json`
- [ ] Updated `IMPLEMENTATION.md` for architectural changes
- [ ] Removed completed items from `TODO.md`
