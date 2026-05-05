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
| `docs/AGENT-OUTPUT-SCHEMAS.md` | Autonomous agent JSON contracts | Agent machine-readable output schemas and examples | Canonical doc for agent structured-output docs |
| `README.md`                   | User documentation               | Setup, configuration, environment variables      | User-facing features & usage                     |
| `docs/HTTP-TRANSPORT.md`      | HTTP transport details           | HTTP transport, sessions, OAuth                  | Transport-specific configuration                |
| `docs/OAUTH.md`               | OAuth 2.0 setup                 | OAuth authentication flow                        | OAuth configuration & troubleshooting           |
| `docs/MULTI-AUTH.md`          | Multi-auth support               | Multiple auth methods with priority              | Multi-auth configuration                         |
| `src/core/errors.ts`          | Error types                      | Error codes, error handling                      | Always define new typed error instead of throwing generic one. Use typed errors, never ad-hoc strings           |
| `TODO.md`                     | Future work & backlog            | P1/P2/P3 prioritized tasks                       | Remove items when implemented                   |
| `docs/PROFILE-TEST-GUIDE.md`  | Profile testing strategies       | Profile test coverage, behavior validation        | Use for writing profile tests                   |

## Directives

- **Never duplicate validation or business rules. Always reference canonical docs.**
- Prefer data-oriented programming - instead of chained if/else or switch statements, use data structures (maps, tables) to define behavior.
- **Senior Delivery Standard (MANDATORY):**
  - Treat implementation requests as senior-level by default unless user explicitly asks for a quick prototype.
  - Prefer modular design with explicit boundaries (for example policy resolver, key builder, store interface, factory/registry) over monolithic feature blocks.
  - Apply clean code principles: single responsibility, composable units, minimal coupling, deterministic behavior, and clear naming.
  - Deliver code complete changes: implementation + validation + tests (success and failure paths) + docs/changelog updates for user-visible behavior.
  - Deliver production quality by default: include observability hooks (metrics/logging where relevant), explicit error taxonomy, and operational guardrails (timeouts, limits, bounded memory/concurrency).
  - Include security-by-default design: least privilege, safe defaults, input validation/sanitization, secret/token redaction, and SSRF/injection considerations for external I/O.
  - Validate failure behavior explicitly: degraded-mode handling, retries/backoff only where safe, and deterministic behavior under partial outages.
  - Add production-oriented tests when behavior is critical (for example auth boundaries, security constraints, limits, eviction, and metrics emission).
  - Preserve extensibility: design new capabilities to support future backends/strategies without high-impact refactors.
  - Keep behavior data-driven where possible (configuration tables/rules) instead of imperative branching chains.
- Prefer test-driven development - for generated theory (aka potential failure, bug or security finding) create failing test confirming it.
- Keep changes consistent with the current test migration: prefer schema-driven profile tests over hardcoded mocks.
- If the user corrects or revises a prior response or implementation, activate the auto-update-skills skill and follow its workflow.
- If repeated tool request request failures require a correction to succeed, activate the `auto-update-skills` skill and follow its workflow.
- Run `npm run typecheck` before finishing work (doesn't required for non-code changes).
- Offer to run `npm audit` (and update dependencies if needed) before finishing work when you decide from time to time.
- Update CHANGELOG.md for more than minimal changes. Prefer user-perspective messages. Always compress lines.
    - don't use multi-line for one change from a user perspective:
    ```markdown
    ### Added
    - GitLab OpenAPI coverage for global issues listing and additional merge request operations (merge, commits, diffs, raw diffs, pipelines).
    - GitLab optimized OAuth profile with CRUD-style tools plus GLQL, along with full profile test coverage.
    - GitLab issue update operation wired into profiles and tests.
    ```
    - instead of this use one-line message:
    ```markdown
    ### Added
    - Expanded GitLab profiles/OpenAPI coverage for global issues and merge request workflow(merge, commits, diffs, raw diffs, pipelines).
    ```
- When a block of work is done, propose a Conventional Commits-style commit message.
- All code comments, MR/PR descriptions and notes, commit messages, and documentation must be written in English.

### Schema Synchronization (CRITICAL)

**Three schema systems must stay in sync:**

1. **TypeScript Types** (`src/types/profile.ts`) - Source of truth
2. **Zod Schemas** (`src/generated-schemas.ts`) - Auto-generated via `npm run generate-schemas`
3. **JSON Schema** (`profile-schema.json`) - Auto-generated by `npm run generate-schemas` for IDE support

**When modifying profile structure:**
1. Edit `src/types/profile.ts`
2. Run `npm run generate-schemas` (auto-generates Zod)
3. Run `npm run check-schema-sync` to verify no schema drift
4. Test with `npm test`

⚠️ **Zod strips unknown properties silently** - missing field in generated schema = feature broken at runtime.

### Profile Development

- Use `npm run validate` to check profiles (no API access required)
- Reference `docs/PROFILE-GUIDE.md` for structure and patterns
- Validate operations exist in OpenAPI spec: `npm run validate -- profile.json openapi.yaml`
- Test incrementally: validate -> build -> test with real API

### TODO.md Maintenance

- **MANDATORY**: Remove items from `TODO.md` immediately after implementation
- Check `TODO.md` before starting new features - may already be planned
- Reference `TODO.md` for implementation details and estimated effort
- Items are prioritized (P1/P2/P3) - respect priority when planning work

### Error Handling

- Use typed errors from `src/core/errors.ts`: `ValidationError`, `AuthenticationError`, `OperationNotFoundError`, etc.
- All errors sent to client include correlation IDs for debugging
- Never return ad-hoc error strings; use structured error types
- Always sanitize tokens and secrets in error messages

### Testing Patterns

- Unit tests: `src/**/*.test.ts` (co-located with source in domain folders)
- Integration tests: `src/testing/*.test.ts`
- E2E tests: `tests/e2e/`
- Mock servers/utilities: `src/testing/dynamic-mock-server.ts`, `src/testing/mock-utils.ts`
- **Each new validator must have both success and failure tests.**
- **When adding new code or behavior changes, add tests to cover it if possible.**
- **Doc-only changes do not require running tests.**
- OAuth profiles require `MCP4_OAUTH_*` env vars in HTTP transport tests and an Authorization header for initialization.
- E2E mock server should include auth validation endpoints used by profile auth configs.

Run specific tests: `npm test -- -t "pattern"`.
Check diff coverage (codecov style): `node scripts/check-diff-coverage.js --base origin/main` (run after `npm test -- --coverage`).

### GitHub repository

Owner: davidruzicka
Repository name: mcp4openapi

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

## GitHub PR Review Scripts

Three pre-allowed scripts for working with PR review threads (no per-call confirmation needed). **Never use `gh` CLI or `gh api` directly — always use these scripts.**

| Script | Usage | Description |
| ------ | ----- | ----------- |
| `scripts/gh-pr-review-threads.sh` | `bash scripts/gh-pr-review-threads.sh <owner/repo> <pr>` | Lists all review threads grouped by OPEN/RESOLVED with thread ID, author, date, and excerpt |
| `scripts/gh-pr-reply-thread.sh` | `bash scripts/gh-pr-reply-thread.sh <owner/repo> <pr> <comment-id> [body]` | Posts a reply to a review thread comment; body can also be piped via stdin |
| `scripts/gh-pr-resolve-threads.sh` | `bash scripts/gh-pr-resolve-threads.sh <owner/repo> <pr> [thread-id ...]` | Resolves given thread IDs, or auto-resolves all open threads where the repo owner has already replied |

**When reviewing PRs:** use `gh-pr-review-threads.sh` to fetch threads, reply to each with `gh-pr-reply-thread.sh`, then run `gh-pr-resolve-threads.sh` (no args = auto mode) to resolve addressed threads in one call.

## Workflow

### Adding New Profile Field

1. Update `src/types/profile.ts` (TypeScript interface)
2. Follow `Schema Synchronization (CRITICAL)` exactly (generate + sync check + tests)
3. Add tests in `src/profile/profile-loader.test.ts`
4. Update `docs/PROFILE-GUIDE.md` if user-facing

### New Feature Steps

1. Define types in `src/types/` if needed
2. Implement core logic (parser, loader, generator, executor)
3. Add typed errors in `src/core/errors.ts` if needed (see `Error Handling`)
4. Write tests (unit -> integration -> e2e) (see `Testing Patterns`)
5. Update documentation (`IMPLEMENTATION.md` for architecture, `docs/` for user-facing)
6. **Remove completed item from `TODO.md`** - if feature was listed there (see `TODO.md Maintenance`)

ALWAYS implement one feature at a time with tests passing before proceeding.

## Avoid

- Returning ORM/raw API responses
- Duplicating constraint tables
- Hard-coding API assumptions (all customization via profiles)
- Ignoring Zod strict mode (unknown properties are silently removed)
- Never use the Unicode em dash (`—`) or en dash (`–`) – always use ASCII hyphen-minus (`-`) in documentation or code comments
- Never recommend implementation of the HSTS security HTTP header (not applicable here)
- For test, validation, and typed-error requirements, follow `Testing Patterns`, `Schema Synchronization (CRITICAL)`, and `Error Handling`.

## Critical Gotchas

1. **Parameter Aliases**: Required for generic OpenAPI path params (e.g., `{id}` → `project_id`).
2. **Metadata Params**: Mark control parameters (e.g., `action`, `resource_type`) that don't go to API.
3. **Token Redaction**: Logger automatically redacts tokens based on profile auth type (bearer/query/custom-header).
4. **OAuth Sessions**: Extended timeout (24h default) vs static token sessions (30min).
5. **Composite Dependencies**: `depends_on` must reference `store_as` values; circular deps detected at load time.

## Environment Variables

**Conditionally required (depending on startup mode):**
- OpenAPI source (one of):
  - `MCP4_OPENAPI_SPEC_PATH` for direct spec startup, or
  - `MCP4_PROFILE` / `--profile` with `openapi_spec_path` defined in the selected profile, or
  - `MCP4_PROFILE_PATH` pointing to a profile file with `openapi_spec_path`.
- Auth token env var required by the selected profile auth config (from `value_from_env`, for example `GITLAB_TOKEN`, `YOUTRACK_TOKEN`). `MCP4_API_TOKEN` is only the default/fallback env var name.

**Optional:**
- `MCP4_PROFILE_PATH`: Profile JSON path (default: auto-generate)
- `MCP4_PROFILE`: Profile ID for profile resolution (equivalent to `--profile`)
- `MCP4_TRANSPORT`: `stdio` (default) or `http`
- `MCP4_API_BASE_URL`: Override OpenAPI server URL (default env name, vary)

See `README.md` for complete list.

## Transport Modes

- **stdio**: MCP SDK `StdioServerTransport` for local development
- **HTTP**: MCP Spec 2025-03-26 compliant (POST/GET/DELETE, SSE, sessions)

Configure via `MCP4_TRANSPORT` environment variable.

## Context Selection Guide

When selecting code for context, prioritize these files based on task:

### Profile-Related Changes
1. `src/types/profile.ts` - Type definitions (source of truth)
2. `src/profile/profile-loader.ts` - Validation & loading logic
3. `src/generated-schemas.ts` - Runtime validation (auto-generated)
4. `profile-schema.json` - JSON Schema (generated from TypeScript types)
5. `docs/PROFILE-GUIDE.md` - User documentation

### Tool Generation Changes
1. `src/tooling/tool-generator.ts` - MCP tool generation
2. `src/types/profile.ts` - Tool definition types
3. `src/openapi/openapi-parser.ts` - OpenAPI operation lookup
4. `src/tooling/composite-executor.ts` - Multi-step execution

### Authentication Changes
1. `src/transport/interceptors.ts` - Auth interceptor implementation
2. `src/types/profile.ts` - Auth config types
3. `src/auth/oauth-provider.ts` - OAuth flow
4. `docs/OAUTH.md` - OAuth setup guide

### HTTP Transport Changes
1. `src/transport/http-transport.ts` - HTTP transport implementation
2. `src/transport/http-client-factory.ts` - Client & session management
3. `src/types/http-transport.ts` - Transport types
4. `docs/HTTP-TRANSPORT.md` - Transport documentation

### Error Handling Changes
1. `src/core/errors.ts` - Error type definitions
2. Component files using errors (e.g., `src/profile/profile-loader.ts`, `src/tooling/tool-generator.ts`)

### Testing
- Always include corresponding `*.test.ts` files when modifying source
- For integration tests: `src/testing/*.test.ts`
- For E2E tests: `tests/e2e/`

### Architecture Understanding
- Start with `IMPLEMENTATION.md` for system overview
- Check `README.md` for user-facing features

Follow these to keep generation consistent & maintainable.

## lean-ctx — Context Engineering Layer

PREFER lean-ctx MCP tools over native equivalents for token savings:

| PREFER | OVER | Why |
|--------|------|-----|
| `ctx_read(path)` | Read / cat / head / tail | Cached, 8 compression modes, re-reads ~13 tokens |
| `ctx_shell(command)` | Shell / bash / terminal | Pattern compression for git/npm/cargo output |
| `ctx_search(pattern, path)` | Grep / rg / search | Compact, token-efficient results |
| `ctx_tree(path, depth)` | ls / find / tree | Compact directory maps |
| `ctx_edit(path, old_string, new_string)` | Edit (when Read unavailable) | Search-and-replace without native Read |

Edit files: use native Edit/StrReplace if available. If Edit requires Read and Read is unavailable, use ctx_edit.
Write, Delete, Glob — use normally. NEVER loop on Edit failures — switch to ctx_edit immediately.

<!-- lean-ctx -->
## lean-ctx

Prefer lean-ctx MCP tools over native equivalents for token savings.
Full rules: @LEAN-CTX.md
<!-- /lean-ctx -->
