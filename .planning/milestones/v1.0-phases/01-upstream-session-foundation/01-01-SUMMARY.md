---
phase: 01-upstream-session-foundation
plan: 01
subsystem: upstream
tags: [mcp-proxy, typed-errors, credentials, redaction, http-headers]

requires:
  - phase: none
    provides: base MCPError class, auth-redaction, SessionData types

provides:
  - Upstream typed errors (UpstreamConnectionError, UpstreamTimeoutError, UpstreamAuthError, UpstreamMalformedResponseError)
  - UpstreamConnectionState and UpstreamConnection types
  - UpstreamCredentialStore with per-provider token storage
  - buildAuthHeaders for bearer and custom-header auth
  - extractUpstreamCredentials for X-Upstream-Authorization header parsing
  - SessionData.upstreamCredentials field
  - Extended SECRET_FIELD_NAMES with upstream credential fields

affects: [01-02, 01-03, upstream-connection-manager, upstream-tool-proxy]

tech-stack:
  added: []
  patterns: [upstream-error-with-correlation-id, credential-store-per-session, header-based-credential-delivery]

key-files:
  created:
    - src/types/upstream-connection.ts
    - src/upstream/upstream-errors.ts
    - src/upstream/upstream-errors.test.ts
    - src/upstream/upstream-credential-store.ts
    - src/upstream/upstream-credential-store.test.ts
    - src/upstream/upstream-credential-extractor.ts
    - src/upstream/upstream-credential-extractor.test.ts
  modified:
    - src/types/http-transport.ts
    - src/auth/auth-redaction.ts
    - src/auth/auth-redaction.test.ts

key-decisions:
  - "X-Upstream-Authorization HTTP header for credential delivery (resolves RESEARCH.md Open Question #1)"
  - "Per-provider token Map in SessionData rather than a credential store reference"
  - "Data-driven auth header builders via lookup table instead of switch/if chains"

patterns-established:
  - "Upstream errors extend MCPError with auto-generated correlationId and sanitized messages"
  - "toMcpErrorResponse strips stack traces for safe client-facing error shape"
  - "Header format: X-Upstream-Authorization: provider=token[,provider2=token2]"

requirements-completed: [PROXY-02, REL-03, SEC-02]

duration: 8min
completed: 2026-03-27
---

# Phase 01 Plan 01: Upstream Foundation Types, Errors, and Credential Infrastructure Summary

**Typed upstream errors with correlation IDs, per-session credential store with auth header builder, and X-Upstream-Authorization header extraction for pass-through credential delivery**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-27T06:27:16Z
- **Completed:** 2026-03-27T06:35:39Z
- **Tasks:** 3
- **Files modified:** 10

## Accomplishments

- Four upstream error classes extending MCPError with correlation IDs and sanitized messages
- UpstreamCredentialStore with set/get/has/clear and buildAuthHeaders for bearer and custom-header auth types
- extractUpstreamCredentials parses X-Upstream-Authorization header into per-provider Map with base64 token support
- SECRET_FIELD_NAMES extended with upstream_token, x_api_key, api_key; sanitizeAuthErrorMessage handles Bearer patterns
- SessionData.upstreamCredentials field and UpstreamConnection/UpstreamCredentials types ready for downstream use

## Task Commits

Each task was committed atomically:

1. **Task 1: Upstream types, typed errors, and error tests** - `e943475` (feat)
2. **Task 2: Credential store, auth header builder, and redaction extension** - `073ad53` (feat)
3. **Task 3: Upstream credential extraction from HTTP headers** - `aa3639e` (feat)

## Files Created/Modified

- `src/types/upstream-connection.ts` - UpstreamConnectionState, UpstreamConnection, UpstreamCredentials types
- `src/upstream/upstream-errors.ts` - 4 error classes + toMcpErrorResponse helper
- `src/upstream/upstream-errors.test.ts` - 16 tests for error types, sanitization, response shape
- `src/upstream/upstream-credential-store.ts` - UpstreamCredentialStore class + buildAuthHeaders function
- `src/upstream/upstream-credential-store.test.ts` - 9 tests for store and header builder
- `src/upstream/upstream-credential-extractor.ts` - extractUpstreamCredentials + UPSTREAM_AUTH_HEADER constant
- `src/upstream/upstream-credential-extractor.test.ts` - 10 tests for header parsing
- `src/types/http-transport.ts` - Added upstreamCredentials field to SessionData
- `src/auth/auth-redaction.ts` - Extended SECRET_FIELD_NAMES and Bearer pattern sanitization
- `src/auth/auth-redaction.test.ts` - 6 new tests for upstream redaction fields

## Decisions Made

- Used X-Upstream-Authorization HTTP header for credential delivery (resolves RESEARCH.md Open Question #1) - keeps credential delivery at transport layer, consistent with existing auth header patterns
- Per-provider token Map in SessionData rather than a credential store reference - simpler serialization and session cleanup
- Data-driven auth header builders via lookup table instead of switch/if chains - follows AGENTS.md data-oriented programming directive

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all implementations are complete and wired.

## Next Phase Readiness

- Types and errors ready for upstream connection manager (Plan 01-02)
- UpstreamCredentialStore ready for session lifecycle integration
- extractUpstreamCredentials ready to be wired into http-transport.ts createSession
- Redaction infrastructure covers all upstream credential fields

## Self-Check: PASSED

- All 10 created/modified files exist
- All 3 task commit hashes verified (e943475, 073ad53, aa3639e)
- 45 tests passing across 4 test files
- Typecheck passes

---
*Phase: 01-upstream-session-foundation*
*Completed: 2026-03-27*
