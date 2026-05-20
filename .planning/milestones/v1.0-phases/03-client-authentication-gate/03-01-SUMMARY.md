---
phase: 03-client-authentication-gate
plan: 01
subsystem: auth
tags: [client-auth-gate, api-keys, profile-validation, zod, json-schema, typescript]

# Dependency graph
requires:
  - phase: 02-tool-discovery-and-call-proxy
    provides: AuthorizedPrincipal interface, profile-loader validation pipeline, enterprise auth validator pattern
provides:
  - ClientAuthGateConfig, ApiKeyStoreConfig, InlineApiKeyEntry types
  - Profile.client_auth_gate optional field
  - SessionData.clientPrincipal (typed AuthorizedPrincipal | undefined)
  - HttpProfileContext.client_auth_gate and HttpTransportConfig.client_auth_gate
  - ClientAuthGateError typed error (code CLIENT_AUTH_GATE_ERROR)
  - validateClientAuthGateProfile() fail-fast validator wired into ProfileLoader.load()
  - Regenerated Zod schemas in src/generated-schemas.ts and profile-schema.json
affects: [03-02, 03-03, 04-oidc-jwt-gate, observability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Profile validator follows enterprise-profile-validator.ts pattern: pure function, fail-fast, returns normalized config or throws typed error"
    - "Phase-staged backend allowlist (ALLOWED_API_KEY_TYPES) prevents accidental shipping of Phase 4 backends"
    - "Mutual exclusion enforcement at validator level: gate vs OAuth interceptor declared incompatible at load time"

key-files:
  created:
    - src/profile/client-auth-gate-validator.ts
    - src/profile/client-auth-gate-validator.test.ts
  modified:
    - src/types/profile.ts
    - src/types/http-transport.ts
    - src/core/errors.ts
    - src/profile/profile-loader.ts
    - src/generated-schemas.ts
    - profile-schema.json
    - CHANGELOG.md

key-decisions:
  - "ClientAuthGateConfig intentionally omits jwt? field in Phase 3; Phase 4 will extend the same interface (no breaking type change for downstream consumers)"
  - "ApiKeyStoreConfig is a discriminated union with only 'inline' shipped; 'sasanka' is rejected with explicit 'not supported' error so misconfigured profiles fail fast in Phase 3"
  - "key_from_env is fail-fast checked at load time (env var must exist) — prevents silent runtime rejection of all keys when an env var is missing"
  - "Mutual exclusion: client_auth_gate is rejected when any OAuth interceptor is configured. Bearer/custom-header/query interceptors are allowed because they target upstream APIs, not inbound clients"
  - "Default mode is 'required' when neither inline value nor mode_from_env is set; mode=required without api_keys is rejected (jwt support is Phase 4)"

patterns-established:
  - "Phase-staged type evolution: Phase 3 ships a subset of the eventual ClientAuthGateConfig surface; Phase 4 extends api_keys union and adds jwt? field. Comments inline at each extension point document the Phase 4 plan."
  - "Profile validator wired into ProfileLoader.load() right after enterprise auth validation, before upstream MCP resolution — keeps inbound auth concerns adjacent in the load pipeline."

requirements-completed: [AUTH-02, AUTH-03]

# Metrics
duration: 5min
completed: 2026-04-29
---

# Phase 03 Plan 01: Client Auth Gate Types, Errors, and Validator Summary

**TypeScript contracts and fail-fast profile validator for the inbound client auth gate (inline API keys), with regenerated Zod/JSON schemas and ClientAuthGateError landing in src/core/errors.ts**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-29T12:57:50Z
- **Completed:** 2026-04-29T13:02:55Z
- **Tasks:** 3
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- Stable, downstream-ready type contracts for the client auth gate: `ClientAuthGateConfig`, `ApiKeyStoreConfig` (inline only), `InlineApiKeyEntry`, and `Profile.client_auth_gate` optional field
- Session-level identity plumbing: `SessionData.clientPrincipal` typed as `AuthorizedPrincipal | undefined`, plus `client_auth_gate` on both `HttpProfileContext` and `HttpTransportConfig` to complete the data flow path Profile → context → transport
- New `ClientAuthGateError` (code `CLIENT_AUTH_GATE_ERROR`) following the existing `MCPError` taxonomy
- Regenerated `src/generated-schemas.ts` and `profile-schema.json` with `inlineApiKeyEntrySchema`, `apiKeyStoreConfigSchema`, `clientAuthGateConfigSchema`; `check-schema-sync` passes
- `validateClientAuthGateProfile()` validator wired into `ProfileLoader.load()` covering: mode default + env resolution, inline keys non-empty + trimmed required fields, fail-fast env var existence check, mutual exclusion with OAuth interceptors, and required-mode-needs-api_keys
- 17 unit tests for the validator (all valid + invalid configurations); full suite of 3249 tests passes with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Add types, error, regenerate schemas** — `54f4b24` (feat)
2. **Task 2 RED: Failing tests for validateClientAuthGateProfile** — `46057aa` (test)
3. **Task 2 GREEN: Implement validator and wire into ProfileLoader** — `44551d4` (feat)
4. **Task 3: CHANGELOG entry** — `afc818d` (chore)

_TDD task 2 produced two commits (test → feat). No refactor commit was needed; first GREEN implementation passed cleanly._

## Files Created/Modified

- `src/profile/client-auth-gate-validator.ts` *(new)* — Fail-fast validator following the enterprise validator pattern; phase-staged `ALLOWED_API_KEY_TYPES` allowlist; mode resolution helper; mutual exclusion check vs OAuth interceptors
- `src/profile/client-auth-gate-validator.test.ts` *(new)* — 17 tests covering valid inline configs, mode default + env override, sasanka/vault rejection, empty/invalid inline entries, fail-fast env var check, mutual exclusion (single + array form), required-mode-needs-api_keys, and bearer-coexistence allowance
- `src/types/profile.ts` — Added `InlineApiKeyEntry`, `ApiKeyStoreConfig`, `ClientAuthGateConfig` types and `Profile.client_auth_gate` optional field with JSDoc anchoring Phase 4 extension points
- `src/types/http-transport.ts` — Added `AuthorizedPrincipal` and `ClientAuthGateConfig` imports; added `SessionData.clientPrincipal`, `HttpProfileContext.client_auth_gate`, and `HttpTransportConfig.client_auth_gate`
- `src/core/errors.ts` — Added `ClientAuthGateError` after `EnterpriseIssuerDiscoveryError`
- `src/profile/profile-loader.ts` — Imported and wired `validateClientAuthGateProfile`; reassignment to `profile.client_auth_gate` after enterprise auth validation, before upstream MCP resolution
- `src/generated-schemas.ts` — Regenerated; new `inlineApiKeyEntrySchema`, `apiKeyStoreConfigSchema`, `clientAuthGateConfigSchema`; `Profile.client_auth_gate` field added to `profileSchema`
- `profile-schema.json` — Regenerated to match
- `CHANGELOG.md` — Added Unreleased > Added entry documenting the new types/error/validator and Phase 4 deferral

## Decisions Made

- **Phase-staged type evolution rather than bag-of-features.** `ClientAuthGateConfig` ships without `jwt?` in Phase 3. Phase 4 extends the same interface — no breaking type change. Both extension sites (api_keys union and the gate config) carry inline comments stating exactly what Phase 4 adds, so the next planner doesn't need to re-derive the design.
- **Strict allowlist for api_keys.type.** `'sasanka'` is rejected today with an explicit "not supported. Allowed: inline" error. This is preferable to leaving sasanka as an inert type — operators get a clear signal that it's not the missing-config bug they think it is.
- **Fail-fast env-var existence check.** Validating that every `key_from_env` env var is set at load time. Without this, a typo in the env var name silently rejects every API key at runtime — the operator sees "unauthorized" with no actionable signal. Now they see startup error at the precise field path with the env var name.
- **Mutual exclusion with OAuth interceptors only.** Bearer/custom-header/query interceptors are allowed alongside `client_auth_gate` because those interceptors target upstream APIs, not inbound clients. Only OAuth interceptors create ambiguous identity flows on the inbound path. Tested both single-object and array-form interceptor configs.
- **Default mode = 'required'.** When neither inline `mode` nor `mode_from_env` is set the gate defaults to `'required'` (closed by default). Combined with the requirement that `mode=required` needs `api_keys` configured, an operator who forgets to configure the gate gets a startup error rather than an open gateway.

## Deviations from Plan

None — plan executed exactly as written. All three tasks landed with the prescribed file set, the validator follows the documented pattern, and no auto-fixes (Rules 1-3) or architectural decisions (Rule 4) were triggered.

## Issues Encountered

None.

## User Setup Required

None — Phase 03-01 ships only types, errors, validator, and schemas. No environment configuration is required to land the change. Operators only need to set the env vars referenced by `key_from_env` once they configure a `client_auth_gate.api_keys` block on a profile, but no profiles ship one in this plan.

## Next Phase Readiness

- Types and the fail-fast validator are stable contracts for `03-02` (in-memory inline-key store + per-session resolver) and `03-03` (transport wiring + AuthorizedPrincipal hand-off into SessionData).
- `SessionData.clientPrincipal` is reserved and typed; `03-03` populates it during session init.
- `HttpProfileContext.client_auth_gate` / `HttpTransportConfig.client_auth_gate` complete the data-flow path so the resolver in `03-02` can read the gate config from session-scoped state without re-resolving the profile.
- No blockers. Phase 4 (OIDC JWT gate) will extend `ClientAuthGateConfig` (`jwt?`) and `ApiKeyStoreConfig` (`'sasanka'` arm) — both extension points are commented in source.

## Self-Check: PASSED

- All claimed files exist on disk (verified with `[ -f ... ]`).
- All four task commits present in `git log` (54f4b24, 46057aa, 44551d4, afc818d).
- `npm run typecheck` exits 0.
- `npm run check-schema-sync` exits 0.
- `npx vitest run` — 154 test files, 3249 tests passed, 0 failed.
- `npx vitest run src/profile/client-auth-gate-validator.test.ts` — 17 tests passed.

---
*Phase: 03-client-authentication-gate*
*Completed: 2026-04-29*
