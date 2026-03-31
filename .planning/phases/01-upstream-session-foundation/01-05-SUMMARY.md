---
phase: 01-upstream-session-foundation
plan: "05"
subsystem: upstream-auth
tags: [upstream-mcp, auth-redaction, validation-endpoint, ssrf, gap-closure]

# Dependency graph
requires:
  - phase: 01-upstream-session-foundation
    provides: UpstreamConnectionManager, buildAuthHeaders, upstream errors

provides:
  - sanitizeAuthErrorMessage with partial Bearer suffix (last 4 chars for diagnostics)
  - redactString exported for direct use
  - validation_endpoint/validation_method/validation_timeout_ms on UpstreamMcpServerConfig
  - UpstreamConnectionManager.validateCredentials() with SSRF protection
  - HttpProfileContext.upstreamMcp field
  - validateCredentials wired into http-transport isInitialization block

affects: [upstream-proxy, http-transport, session-management, auth-redaction]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SSRF-first validation: ssrfValidator.validate() called before any HTTP probe"
    - "Opt-in early auth validation: no-op when validation_endpoint absent"
    - "Bearer suffix preservation: JWT regex fires first, then Bearer regex preserves last 4 chars"
    - "501/502 separation: UpstreamAuthError -> 401, everything else -> 502"

key-files:
  created:
    - src/transport/http-transport.upstream-validation.test.ts
  modified:
    - src/auth/auth-redaction.ts
    - src/auth/auth-redaction.test.ts
    - src/types/profile.ts
    - src/types/http-transport.ts
    - src/upstream/upstream-connection-manager.ts
    - src/upstream/upstream-connection-manager.test.ts
    - src/transport/http-transport.ts
    - src/mcp/mcp-server.ts
    - src/generated-schemas.ts
    - profile-schema.json
    - CHANGELOG.md

key-decisions:
  - "Bearer suffix preserves original case of Bearer keyword (gi flag captures prefix group)"
  - "validateCredentials no-ops on missing token - pass-through model means undefined token is valid (server-env fallback)"
  - "HTTP 502 for SSRF/timeout/connection errors during upstream validation (not 401 - the upstream itself is at fault)"
  - "AbortSignal.timeout() used for validation probe timeouts - native, no external dependency"

# Metrics
duration: 6min
completed: 2026-03-30
---

# Phase 01 Plan 05: Auth Redaction Suffix + Upstream Validation Endpoint Summary

**Bearer token redaction with diagnostic suffix preservation, SSRF-protected opt-in upstream credential validation at session init, and wiring into http-transport isInitialization block**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-03-30T08:06:00Z
- **Completed:** 2026-03-30T08:12:32Z
- **Tasks:** 3
- **Files modified:** 10 (plus 1 created, 2 generated)

## Accomplishments

- `sanitizeAuthErrorMessage` now preserves last 4 chars of Bearer tokens as diagnostic suffix: `Bearer [REDACTED]...xQ5g`
- `redactString` exported for direct testing; structured field redaction unchanged (fully redacts)
- `UpstreamMcpServerConfig` gains `validation_endpoint`, `validation_method`, `validation_timeout_ms` fields
- `UpstreamConnectionManager.validateCredentials()`: SSRF-first HTTP probe, throws `UpstreamAuthError` on 401/403, `UpstreamTimeoutError` on abort, `UpstreamConnectionError` on network failure
- `HttpProfileContext.upstreamMcp` field added; `getHttpProfileContext()` populates it from `profile.upstream_mcp`
- `http-transport.ts` isInitialization block iterates providers with `validation_endpoint`, calls `validateCredentials`, returns 401 on auth failure and 502 on infrastructure failure
- Zod schemas and JSON Schema regenerated and in sync
- All 562 tests pass, typecheck clean

## Task Commits

1. **Task 1: Bearer token redaction with partial suffix** - `8525ca6`
2. **Task 2: validation_endpoint with SSRF protection** - `96c56d2`
3. **Task 3: Wire validateCredentials into http-transport init** - `6b7d951`

## Files Created/Modified

- `src/auth/auth-redaction.ts` - Export redactString; suffix-preserving Bearer regex
- `src/auth/auth-redaction.test.ts` - 8 new tests for suffix behavior and redactString export
- `src/types/profile.ts` - Add validation_endpoint/validation_method/validation_timeout_ms to UpstreamMcpServerConfig
- `src/types/http-transport.ts` - Add upstreamMcp field to HttpProfileContext
- `src/upstream/upstream-connection-manager.ts` - ssrfValidator/logger options; validateCredentials() method
- `src/upstream/upstream-connection-manager.test.ts` - 13 new tests for validateCredentials
- `src/transport/http-transport.ts` - Import UpstreamAuthError; upstream validation wiring in isInitialization block
- `src/transport/http-transport.upstream-validation.test.ts` - CREATED: 6 tests for wiring behavior
- `src/mcp/mcp-server.ts` - getHttpProfileContext() now includes upstreamMcp
- `src/generated-schemas.ts` - Auto-regenerated
- `profile-schema.json` - Auto-regenerated
- `CHANGELOG.md` - User-facing entries for both changes

## Decisions Made

- Bearer suffix preserves original case of Bearer keyword using capture group `(Bearer)` so `bearer` stays lowercase and `Bearer` stays capitalized
- JWT regex fires before Bearer regex, so JWT-format tokens in error messages always get `[REDACTED_JWT]` - Bearer regex never matches already-redacted text
- `validateCredentials` no-ops when token is undefined - consistent with pass-through model where server-env fallback tokens are valid
- HTTP 502 used for SSRF/timeout/connection errors to distinguish from client auth failure (401)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- UAT Gaps 2 and 3 are now closed
- Phase 01 is complete (all 5 plans executed)
- Ready for phase transition

---
*Phase: 01-upstream-session-foundation*
*Completed: 2026-03-30*
