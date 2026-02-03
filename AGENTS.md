# AI Coding Agent Guide

Reference canonical sources; never duplicate rules.

## Canonical Sources

| File                          | Purpose                          | Scope Boundary                                    | Prevails Over / Notes                           |
| ----------------------------- | -------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `IMPLEMENTATION.md`           | Architecture & design decisions  | System design, component interactions            | Prevails over all except STYLE.md               |
| `docs/PROFILE-GUIDE.md`       | Profile creation & validation     | Profile structure, tool definitions, best practices | Use for profile-related questions                |
| `src/types/profile.ts`        | Profile type definitions         | TypeScript interfaces for profiles                | Source of truth for profile structure            |
| `profile-schema.json`         | JSON Schema for profiles         | IDE autocomplete, JSON validation                | Must stay in sync with TypeScript types         |
| `src/generated-schemas.ts`    | Zod runtime schemas              | Runtime validation, parsing                      | Auto-generated from TypeScript types            |
| `README.md`                   | User documentation               | Setup, configuration, environment variables      | User-facing features & usage                     |
| `docs/HTTP-TRANSPORT.md`      | HTTP transport details           | HTTP transport, sessions, OAuth                  | Transport-specific configuration                |
| `docs/OAUTH.md`               | OAuth 2.0 setup                 | OAuth authentication flow                        | OAuth configuration & troubleshooting           |
| `docs/MULTI-AUTH.md`          | Multi-auth support               | Multiple auth methods with priority              | Multi-auth configuration                         |
| `src/errors.ts`               | Error types                      | Error codes, error handling                      | Always define new typed error instead of throwing generic one. Use typed errors, never ad-hoc strings           |
| `TODO.md`                     | Future work & backlog            | P1/P2/P3 prioritized tasks                       | Remove items when implemented                   |
| `docs/PROFILE-TEST-GUIDE.md`  | Profile testing strategies       | Profile test coverage, behavior validation        | Use for writing profile tests                   |

## Directives

- **Never duplicate validation or business rules. Always reference canonical docs.**
- Keep changes consistent with the current test migration: prefer schema-driven profile tests over hardcoded mocks.
- Run `npm run typecheck` before finishing work.
- Offer to run `npm audit` (and update dependencies if needed) before finishing work (requires escalated permissions, can't run in sandbox).

### Schema Synchronization (CRITICAL)

**Three schema systems must stay in sync:**

1. **TypeScript Types** (`src/types/profile.ts`) - Source of truth
2. **Zod Schemas** (`src/generated-schemas.ts`) - Auto-generated via `npm run generate-schemas`
3. **JSON Schema** (`profile-schema.json`) - Manual update for IDE support

**When modifying profile structure:**
1. Edit `src/types/profile.ts`
2. Run `npm run generate-schemas` (auto-generates Zod)
3. **Manually update** `profile-schema.json` (for IDE autocomplete)
4. Test with `npm test`

⚠️ **Zod strips unknown properties silently** - missing field in generated schema = feature broken at runtime.

### Profile Development

- Use `npm run validate` to check profiles (no API access required)
- Reference `docs/PROFILE-GUIDE.md` for structure and patterns
- Validate operations exist in OpenAPI spec: `npm run validate -- profile.json openapi.yaml`
- Test incrementally: validate → build → test with real API

### TODO.md Maintenance

- **MANDATORY**: Remove items from `TODO.md` immediately after implementation
- Check `TODO.md` before starting new features - may already be planned
- Reference `TODO.md` for implementation details and estimated effort
- Items are prioritized (P1/P2/P3) - respect priority when planning work

### Error Handling

- Use typed errors from `src/errors.ts`: `ValidationError`, `AuthenticationError`, `OperationNotFoundError`, etc.
- All errors sent to client include correlation IDs for debugging
- Never return ad-hoc error strings; use structured error types
- Always sanitize tokens and secrets in error messages

### Testing Patterns

- Unit tests: `src/*.test.ts` (co-located with source)
- Integration tests: `src/testing/*.test.ts`
- E2E tests: `tests/e2e/`
- Mock servers: `src/testing/mock-*-server.ts` (MSW-based)
- Fixtures: `src/testing/fixtures.ts`
- **Each new validator must have both success and failure tests.**
- **When adding new code or behavior changes, add tests to cover it if possible.**
- **Doc-only changes do not require running tests.**
- OAuth profiles require `MCP4_OAUTH_*` env vars in HTTP transport tests and an Authorization header for initialization.
- E2E mock server should include auth validation endpoints used by profile auth configs.

Run specific tests: `npm test -- -t "pattern"`.
Check diff coverage (codecov style): `node scripts/check-diff-coverage.js` (run after `npm test -- --coverage`).

### Code Organization

- Source: `src/{feature}.ts` or `src/{feature}/`
- Types: `src/types/{domain}.ts`
- Testing utilities: `src/testing/`
- Profiles: `profiles/{api-name}/`
- Scripts: `scripts/`

### Interceptor Chain

Order: `auth → rate-limit → retry → fetch`

Each interceptor is independently testable. Configuration in profile `interceptors` section.

### Composite Tools

- Use `steps[]` with `store_as` JSONPath for result aggregation
- Supports `depends_on` for parallel execution (DAG-based)
- `partial_results: true` returns completed steps even if later steps fail
- Parameter aliases automatically applied in composite steps

### OpenAPI Parsing

- `$ref` resolution for parameters (not full schema resolution yet)
- Operation lookup: O(1) via Map index
- Fast startup: ~500ms for large specs (3600+ lines)

## Workflow

### Adding New Profile Field

1. Update `src/types/profile.ts` (TypeScript interface)
2. Run `npm run generate-schemas` (auto-generates Zod)
3. **Manually update** `profile-schema.json` (for IDE autocomplete)
4. Add tests in `src/profile-loader.test.ts`
5. Update `docs/PROFILE-GUIDE.md` if user-facing

### New Feature Steps

1. Define types in `src/types/` if needed
2. Implement core logic (parser, loader, generator, executor)
3. Add typed errors in `src/errors.ts` if needed
4. Write tests (unit → integration → e2e)
5. Update documentation (`IMPLEMENTATION.md` for architecture, `docs/` for user-facing)
6. **Remove completed item from `TODO.md`** - if feature was listed there

ALWAYS implement one feature at a time with tests passing before proceeding.

### Profile Validation

```bash
# Structure only
npm run validate -- profiles/my-profile.json

# Structure + OpenAPI operation check
npm run validate -- profiles/my-profile.json openapi.yaml
```

Checks: JSON syntax, schema compliance, logical consistency, operation existence.

### Build & Test

```bash
npm run build          # generate-schemas + tsc
npm test               # typecheck + vitest
npm run validate       # profile validation
npm start              # run server
```

## Avoid

- Duplicating validation or business rules (reference canonical docs)
- Returning ORM/raw API responses
- Broad catch-all exceptions (use specific error types)
- Duplicating constraint tables
- Hard-coding API assumptions (all customization via profiles)
- Skipping schema sync (always run `npm run generate-schemas` after type changes)
- Ignoring Zod strict mode (unknown properties are silently removed)
- Never use the Unicode em dash (`—`) or en dash (`–`) – always use ASCII hyphen-minus (`-`) in documentation or code comments
- Never recommend implementation of the HSTS security HTTP header (not applicable here)

## Critical Gotchas

1. **Schema Sync**: TypeScript → Zod → JSON Schema must match. Missing Zod field = runtime failure.
2. **Profile Validation**: Operations must exist in OpenAPI spec. Use `npm run validate` with spec path.
3. **Parameter Aliases**: Required for generic OpenAPI path params (e.g., `{id}` → `project_id`).
4. **Metadata Params**: Mark control parameters (e.g., `action`, `resource_type`) that don't go to API.
5. **Token Redaction**: Logger automatically redacts tokens based on profile auth type (bearer/query/custom-header).
6. **OAuth Sessions**: Extended timeout (24h default) vs static token sessions (30min).
7. **Composite Dependencies**: `depends_on` must reference `store_as` values; circular deps detected at load time.

## Environment Variables

**Required:**
- `MCP4_OPENAPI_SPEC_PATH`: Path/URL to OpenAPI spec
- `MCP4_API_TOKEN`: API token (default env var name)

**Optional:**
- `MCP4_PROFILE_PATH`: Profile JSON path (default: auto-generate)
- `MCP4_TRANSPORT`: `stdio` (default) or `http`
- `MCP4_API_BASE_URL`: Override OpenAPI server URL

See `README.md` for complete list.

## Transport Modes

- **stdio**: MCP SDK `StdioServerTransport` for local development
- **HTTP**: MCP Spec 2025-03-26 compliant (POST/GET/DELETE, SSE, sessions)

Configure via `MCP4_TRANSPORT` environment variable.

## Context Selection Guide

When selecting code for context, prioritize these files based on task:

### Profile-Related Changes
1. `src/types/profile.ts` - Type definitions (source of truth)
2. `src/profile-loader.ts` - Validation & loading logic
3. `src/generated-schemas.ts` - Runtime validation (auto-generated)
4. `profile-schema.json` - JSON Schema (manual update)
5. `docs/PROFILE-GUIDE.md` - User documentation

### Tool Generation Changes
1. `src/tool-generator.ts` - MCP tool generation
2. `src/types/profile.ts` - Tool definition types
3. `src/openapi-parser.ts` - OpenAPI operation lookup
4. `src/composite-executor.ts` - Multi-step execution

### Authentication Changes
1. `src/interceptors.ts` - Auth interceptor implementation
2. `src/types/profile.ts` - Auth config types
3. `src/oauth-provider.ts` - OAuth flow
4. `docs/OAUTH.md` - OAuth setup guide

### HTTP Transport Changes
1. `src/http-transport.ts` - HTTP transport implementation
2. `src/http-client-factory.ts` - Client & session management
3. `src/types/http-transport.ts` - Transport types
4. `docs/HTTP-TRANSPORT.md` - Transport documentation

### Error Handling Changes
1. `src/errors.ts` - Error type definitions
2. Component files using errors (e.g., `profile-loader.ts`, `tool-generator.ts`)

### Testing
- Always include corresponding `*.test.ts` files when modifying source
- For integration tests: `src/testing/*.test.ts`
- For E2E tests: `tests/e2e/`

### Architecture Understanding
- Start with `IMPLEMENTATION.md` for system overview
- Reference `.github/copilot-instructions.md` for development patterns
- Check `README.md` for user-facing features

Follow these to keep generation consistent & maintainable.
