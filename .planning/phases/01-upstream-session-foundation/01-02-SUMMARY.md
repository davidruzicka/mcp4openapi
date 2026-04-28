---
phase: 01-upstream-session-foundation
plan: 02
subsystem: upstream
tags: [mcp-proxy, connection-manager, lazy-connect, session-lifecycle, concurrency-dedup]

requires:
  - phase: 01-upstream-session-foundation
    provides: UpstreamConnectionState/UpstreamConnection types, UpstreamCredentialStore with buildAuthHeaders, typed upstream errors

provides:
  - UpstreamConnectionManager with lazy getOrConnect, concurrent dedup, and closeAll
  - Session destruction integration via onSessionDestroyed listener in http-transport.ts
  - getConnection and getActiveSessionCount for observability

affects: [01-03, upstream-tool-proxy, upstream-notification-forwarding]

tech-stack:
  added: []
  patterns: [pending-promise-dedup, factory-injection-for-testability, session-scoped-connection-map]

key-files:
  created:
    - src/upstream/upstream-connection-manager.ts
    - src/upstream/upstream-connection-manager.test.ts
  modified:
    - src/transport/http-transport.ts

key-decisions:
  - "Factory injection (clientFactory, transportFactory) for testability instead of direct MCP SDK instantiation"
  - "Promise-based pending connection dedup via Map key sessionId:providerName"
  - "Setter method setUpstreamConnectionManager instead of constructor param for clean separation"

patterns-established:
  - "Pending promise dedup pattern: Map<string, Promise<T>> keyed by composite key prevents concurrent duplicate operations"
  - "Transport event handlers set state to FAILED for automatic reconnection on next getOrConnect"
  - "closeAll swallows transport.close errors to never break session destruction"

requirements-completed: [PROXY-01, REL-02]

duration: 4min
completed: 2026-03-27
---

# Phase 01 Plan 02: Upstream Connection Manager with Session Lifecycle Integration Summary

**Per-session upstream MCP connection manager with lazy getOrConnect, concurrent dedup via pending promise map, and session destruction wiring via onSessionDestroyed listener**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-27T06:40:12Z
- **Completed:** 2026-03-27T06:43:50Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- UpstreamConnectionManager lazily creates upstream connections only on first tool use (PROXY-01)
- Concurrent getOrConnect calls deduplicated via pendingConnections promise map - no duplicate connections
- closeAll closes all transports for a session and integrates with session reaper/DELETE/shutdown (REL-02)
- Connect errors mapped to typed UpstreamConnectionError/TimeoutError/AuthError with credential sanitization
- setUpstreamConnectionManager wires closeAll into http-transport.ts session destruction lifecycle

## Task Commits

Each task was committed atomically:

1. **Task 1: UpstreamConnectionManager with lazy getOrConnect, concurrency dedup, and closeAll** - `9729d14` (feat)
2. **Task 2: Wire UpstreamConnectionManager.closeAll into session destruction lifecycle** - `c252062` (feat)

## Files Created/Modified

- `src/upstream/upstream-connection-manager.ts` - UpstreamConnectionManager class with getOrConnect, closeAll, getConnection, getActiveSessionCount
- `src/upstream/upstream-connection-manager.test.ts` - 22 tests covering lazy init, dedup, closeAll, error mapping, transport events, session destruction
- `src/transport/http-transport.ts` - Import, field, and setUpstreamConnectionManager method with onSessionDestroyed listener

## Decisions Made

- Factory injection (clientFactory, transportFactory) for full testability without MCP SDK mocking complexity
- Promise-based pending connection dedup via Map keyed by `${sessionId}:${providerName}` - simplest correct concurrency solution
- Setter method `setUpstreamConnectionManager` instead of constructor param - avoids changing HttpTransport constructor signature, allows optional wiring

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all implementations are complete and wired.

## Next Phase Readiness

- UpstreamConnectionManager ready for upstream tool proxy (Plan 01-03)
- Session destruction integration complete - no upstream connection leaks possible
- getConnection available for health checks and observability
- Factory injection pattern ready for production wiring with real MCP SDK Client/Transport

## Self-Check: PASSED

- All 3 created/modified files exist
- Both task commit hashes verified (9729d14, c252062)
- 22 tests passing
- Typecheck passes

---
*Phase: 01-upstream-session-foundation*
*Completed: 2026-03-27*
