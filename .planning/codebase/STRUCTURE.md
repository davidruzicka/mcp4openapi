# Directory Structure

## Top-level Layout

```
/workspace/
├── src/                  # All TypeScript source code
├── profiles/             # JSON MCP profile definitions per API
├── scripts/              # Build/automation scripts (implementor pipeline)
├── tests/e2e/            # End-to-end tests
├── dist/                 # Compiled output (gitignored)
├── html/                 # Static HTML assets (MCP Apps widgets)
├── docs/                 # User-facing documentation
├── .github/workflows/    # GitHub Actions CI/CD + implementor pipeline
├── .planning/            # GSD project planning (gitignored from some views)
├── profile-schema.json   # JSON Schema for profile IDE autocomplete
├── IMPLEMENTATION.md     # Architecture reference
├── TODO.md               # Prioritized backlog
└── CHANGELOG.md          # User-facing changelog
```

## src/ Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/auth/` | OAuth 2.0 provider, PKCE, JWKS, enterprise auth |
| `src/automation/` | Autonomous issue-to-PR pipeline (implementor, codex, planner) |
| `src/core/` | Errors, naming, shared utilities |
| `src/mcp/` | MCP server, tool/resource/prompt registration, apps model |
| `src/openapi/` | OpenAPI spec parsing, operation lookup, $ref resolution |
| `src/profile/` | Profile loading, validation, enterprise profile validator |
| `src/prompt/` | MCP prompt definitions from profiles |
| `src/security/` | SSRF validator, scheme validation |
| `src/testing/` | Shared test utilities, mock servers, integration test harness |
| `src/tool-filter/` | Tool name normalization, regex filtering, ReDoS protection |
| `src/tooling/` | MCP tool generation, composite executor, parameter aliases |
| `src/transport/` | HTTP interceptor chain (auth, rate-limit, retry, fetch) |
| `src/types/` | TypeScript interfaces (source of truth for all types) |
| `src/validation/` | Input validation utilities (URI, property name safety) |

## Key File Locations

### Entry Points
- `src/index.ts` - Main CLI entry point, stdio/HTTP mode selection
- `src/core/index.ts` - Server bootstrap, profile loading, transport init
- `src/mcp/mcp-server.ts` - Central MCP server (2700+ lines - known concern)

### Type Definitions (Source of Truth)
- `src/types/profile.ts` - Profile interface (edit this first for profile changes)
- `src/types/openapi.ts` - OpenAPI operation/schema types
- `src/types/http-transport.ts` - HTTP transport types
- `src/generated-schemas.ts` - Auto-generated Zod schemas (never edit manually)
- `profile-schema.json` - Auto-generated JSON Schema (never edit manually)

### Profile System
- `src/profile/profile-loader.ts` - Validation + loading logic
- `src/profile/enterprise-profile-validator.ts` - Enterprise auth validation
- `src/profile/profile-apps.ts` - Resource/Apps model construction

### Transport & Auth
- `src/transport/interceptors.ts` - Auth/rate-limit/retry/fetch interceptor chain
- `src/transport/http-transport.ts` - HTTP transport (Express-based, MCP 2025-03-26)
- `src/transport/http-client-factory.ts` - Per-session HTTP client management
- `src/auth/oauth-provider.ts` - OAuth 2.0 + PKCE flow
- `src/auth/enterprise-auth-provider.ts` - Enterprise JWKS/managed auth

### Scripts
- `scripts/run-implementor.ts` - Implementor pipeline entry point
- `scripts/implementor-command.ts` - Command execution + fallback logic
- `scripts/generate-schemas.js` - Regenerates Zod + JSON Schema from TypeScript types

## Naming Conventions

| Pattern | Example |
|---------|---------|
| Feature files | `src/{feature}/{feature-name}.ts` |
| Co-located tests | `src/{feature}/{feature-name}.test.ts` |
| Type files | `src/types/{domain}.ts` |
| Integration tests | `src/testing/*.test.ts` |
| E2E tests | `tests/e2e/*.test.ts` |
| Profile directories | `profiles/{api-name}/` |
| Profile files | `profiles/{api-name}/{profile-id}.json` |

## Where to Add New Code

| Task | Location |
|------|---------|
| New profile field | `src/types/profile.ts` → run `npm run generate-schemas` |
| New error type | `src/core/errors.ts` |
| New auth strategy | `src/transport/interceptors.ts` + `src/types/profile.ts` |
| New MCP capability | `src/mcp/mcp-server.ts` |
| New OpenAPI feature | `src/openapi/openapi-parser.ts` |
| New profile | `profiles/{api-name}/` + validate with `npm run validate` |
| New automation step | `src/automation/` |
