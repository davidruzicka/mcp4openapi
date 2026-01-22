# Plan - Profile selection (CLI) and profile routing (HTTP)

## Plan A - CLI `mcp4openapi --profile gitlab`
- [x] **Confirm inputs and precedence**
  - [x] Define CLI args: `--profile`, `--profiles-dir`, `--profile-path`, `--openapi-spec-path`.
  - [x] Allow every env var setting to be passed as a CLI flag by dropping the `MCP4_` prefix and converting to kebab-case (e.g., `MCP4_PROFILE_PATH` -> `--profile-path`, `MCP4_OPENAPI_SPEC_PATH` -> `--openapi-spec-path`). Keep existing flag style.
  - [x] Define precedence: CLI args > env vars > defaults.
  - [x] Decide on discovery: manifest vs scan `profiles/**.json`.

- [x] **Add profile resolver module**
  - [x] Create `src/profile-resolver.ts` to resolve `{ profilePath, specPath, profileName }` from `profileId`.
  - [x] Support `profile_id`, `profile_aliases`, and `openapi_spec_path` in profile JSON.
  - [x] Use typed errors from `src/errors.ts` for missing/ambiguous profiles or missing spec path.

- [x] **Add unit tests for resolver**
  - [x] Happy path: resolve `profileId` to correct profile/spec paths.
  - [x] Not found: profile ID not present.
  - [x] Missing `openapi_spec_path` in profile.
  - [x] Ambiguous alias conflict.

- [x] **Extend CLI parsing and startup**
  - [x] Update `src/index.ts` to parse CLI args and apply precedence.
  - [x] If `--profile` is provided, use resolver to set `specPath` + `profilePath`.
  - [x] If `--profile-path` or `--openapi-spec-path` is provided, skip resolver.

- [x] **Schema updates for new profile fields**
  - [x] Update `src/types/profile.ts` with new fields.
  - [x] Run `npm run generate-schemas` to update `src/generated-schemas.ts`.
  - [x] Manually update `profile-schema.json` to match.

- [x] **Docs updates**
  - [x] `README.md`: document `--profile` usage and precedence.
  - [x] `README.md`: add a short note that the env->CLI mapping rule applies generically; include examples only (not an exhaustive list).
  - [x] `docs/PROFILE-GUIDE.md`: document new fields and example.

- [x] **Sanity checks**
  - [x] Run `npm run typecheck`.
  - [x] Run targeted tests for resolver.

---

## Plan B - HTTP profile routing `/profile/:id/mcp`
- [x] **Introduce multi-profile manager**
  - [x] Create `ProfileRegistry` (reuse resolver from Plan A).
  - [x] Create `MCPServerManager` to lazily initialize `MCPServer` per profile.
  - [x] Unit tests: same profile ID returns same instance, lazy init works.

- [x] **Add profile-aware HTTP routing**
  - [x] Update `src/http-transport.ts` to support `/profile/:profileId/mcp` and `/profile/:profileId/sse`.
  - [x] Extend message handler to pass `profileId`.
  - [x] Key sessions by `(profileId, sessionId)` to avoid collisions.
  - [x] Unit tests: `POST /profile/:id/mcp` calls handler with correct `profileId`.

- [x] **Wire routing to MCPServerManager**
  - [x] Update `runHttp` flow to route requests based on `profileId`.
  - [x] Integrate manager into HTTP start path.
  - [x] Integration test: `/profile/gitlab/mcp` returns tools for gitlab profile.

- [x] **OAuth and .well-known per profile**
  - [x] Register OAuth routes under `/profile/:id/` when routing is enabled.
  - [x] Ensure issuer/resource identifiers include `/profile/:id`.
  - [x] Minimal tests for `/.well-known/oauth-protected-resource` per profile.

- [x] **Compatibility, default profile, and feature flag**
  - [x] If default profile configured (`MCP4_PROFILE_PATH` or `--profile-path`), keep `/mcp`.
  - [x] If no default profile, do not register `/mcp`.
  - [x] Require `MCP4_HTTP_PROFILE_ROUTING=true` when no default profile is set.
  - [x] Fail fast if no default profile and routing flag off with:
        "HTTP profile routing is disabled and no default profile is configured.\nSet MCP4_HTTP_PROFILE_ROUTING=true to enable /profile/:id/mcp routes, or provide MCP4_PROFILE_PATH (or --profile-path) to serve /mcp."
  - [ ] Tests:
        - [x] Default profile set -> `/mcp` exists.
        - [x] No default + routing flag on -> `/mcp` missing, `/profile/:id/mcp` works.
        - [x] No default + routing flag off -> startup fails with the error above.

- [x] **Docs updates**
  - [x] `docs/HTTP-TRANSPORT.md`: document `/profile/:id/mcp`, OAuth/.well-known paths, and flag behavior.
  - [x] `README.md`: add HTTP routing examples and default profile rules.

- [x] **Final checks**
  - [x] Run `npm run typecheck`.
  - [x] Run targeted HTTP routing tests.

- [x] **Spec alignment improvement (optional)**
  - [x] Add root-level protected resource metadata endpoint and document resource query usage for per-profile discovery.
