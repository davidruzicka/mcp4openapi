---
phase: 01-upstream-session-foundation
plan: "04"
subsystem: upstream
tags: [upstream-mcp, credential-passthrough, refactor, dead-code-removal]

# Dependency graph
requires:
  - phase: 01-upstream-session-foundation
    provides: UpstreamConnectionManager, buildAuthHeaders, upstream types

provides:
  - buildAuthHeaders(provider, token: string | undefined) - simplified direct token parameter
  - getOrConnect(sessionId, provider, token: string | undefined) - simplified direct token parameter
  - Dead code removed: upstream-credential-extractor.ts, UpstreamCredentialStore class, UpstreamCredentials interface, SessionData.upstreamCredentials

affects: [upstream-proxy, http-transport, session-management]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Profile-per-upstream model: one token per session, direct passthrough via Authorization header"
    - "buildAuthHeaders takes plain string token instead of credentials interface"

key-files:
  created: []
  modified:
    - src/upstream/upstream-credential-store.ts
    - src/upstream/upstream-credential-store.test.ts
    - src/upstream/upstream-connection-manager.ts
    - src/upstream/upstream-connection-manager.test.ts
    - src/types/upstream-connection.ts
    - src/types/http-transport.ts
  deleted:
    - src/upstream/upstream-credential-extractor.ts
    - src/upstream/upstream-credential-extractor.test.ts

key-decisions:
  - "Profile-per-upstream model confirmed: no multi-provider credential aggregation; X-Upstream-Authorization header and UpstreamCredentials interface were wrong-model dead code"
  - "buildAuthHeaders and getOrConnect accept token: string | undefined directly - no wrapper interface needed"

patterns-established:
  - "Auth header builder takes plain token string, not a credentials interface - matches profile-per-upstream reality"

requirements-completed: [PROXY-02, SEC-02]

# Metrics
duration: 5min
completed: 2026-03-30
---

# Phase 01 Plan 04: Credential Model Simplification Summary

**Deleted X-Upstream-Authorization extractor and UpstreamCredentials interface; simplified buildAuthHeaders and getOrConnect to accept plain token string per profile-per-upstream model**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-30T07:59:35Z
- **Completed:** 2026-03-30T08:02:00Z
- **Tasks:** 2
- **Files modified:** 6 (plus 2 deleted)

## Accomplishments
- Deleted dead aggregation-model code: upstream-credential-extractor.ts + test, UpstreamCredentialStore class, UpstreamCredentials interface, SessionData.upstreamCredentials field
- buildAuthHeaders now accepts (provider, token: string | undefined) - no credentials wrapper
- getOrConnect and createConnection now accept token: string | undefined directly
- All 237 upstream + auth tests pass, typecheck clean with zero errors

## Task Commits

1. **Task 1: Delete extractor, remove UpstreamCredentials, remove SessionData.upstreamCredentials** - `0bed08b` (feat)
2. **Task 2: Simplify buildAuthHeaders and getOrConnect (TDD)** - `0e6c880` (feat)

## Files Created/Modified
- `src/upstream/upstream-credential-extractor.ts` - DELETED (dead aggregation-model code)
- `src/upstream/upstream-credential-extractor.test.ts` - DELETED
- `src/upstream/upstream-credential-store.ts` - Removed UpstreamCredentialStore class; buildAuthHeaders now takes token: string | undefined
- `src/upstream/upstream-credential-store.test.ts` - Rewrote to test simplified signature; 5 tests
- `src/upstream/upstream-connection-manager.ts` - getOrConnect and createConnection take token: string | undefined
- `src/upstream/upstream-connection-manager.test.ts` - Removed UpstreamCredentials import and createCredentials() helper; uses plain string
- `src/types/upstream-connection.ts` - Removed UpstreamCredentials interface
- `src/types/http-transport.ts` - Removed SessionData.upstreamCredentials field

## Decisions Made
- Profile-per-upstream model means each session connects to exactly one upstream with one token from the session's authToken field. No multi-provider credential map needed. The X-Upstream-Authorization header design was based on a wrong aggregation assumption.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Upstream connection manager now has clean token passthrough API
- Callers of getOrConnect need to pass session.authToken directly (string | undefined)
- Ready for plan 05: wire session.authToken into getOrConnect call sites in http-transport

---
*Phase: 01-upstream-session-foundation*
*Completed: 2026-03-30*
