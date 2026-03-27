---
phase: 01-upstream-session-foundation
plan: 03
subsystem: upstream
tags: [mcp-proxy, heartbeat, health-monitoring, connection-resilience]

requires:
  - phase: 01-upstream-session-foundation/01-01
    provides: UpstreamConnectionError, UpstreamConnection types with heartbeatTimer field

provides:
  - UpstreamHeartbeatManager class with start/stop/stopAll/isRunning/getActiveCount
  - HeartbeatConfig interface and DEFAULT_HEARTBEAT_CONFIG constants
  - Configurable ping interval (default 30s) and timeout (default 5s)

affects: [upstream-connection-manager, upstream-session-lifecycle, upstream-reconnection]

tech-stack:
  added: []
  patterns: [delegated-ping-timeout, map-keyed-timer-management, idempotent-start]

key-files:
  created:
    - src/upstream/upstream-heartbeat.ts
    - src/upstream/upstream-heartbeat.test.ts
  modified:
    - CHANGELOG.md

key-decisions:
  - "Ping timeout delegated to caller via pingFn parameter rather than internal AbortController - keeps manager simple and testable"
  - "Timer map keyed by string (sessionId:providerName) for flexible multi-connection support"

patterns-established:
  - "Heartbeat manager uses delegated ping function pattern - caller wraps client.ping({ timeout }) as pingFn"
  - "Idempotent start via Map.has() guard prevents duplicate timer accumulation"

requirements-completed: [REL-01, REL-02, REL-03]

duration: 2min
completed: 2026-03-27
---

# Phase 01 Plan 03: Upstream Heartbeat Health Monitoring Summary

**UpstreamHeartbeatManager with configurable 30s ping interval, failure callbacks, idempotent start, and cleanup - 21 tests with fake timers**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-27T06:39:43Z
- **Completed:** 2026-03-27T06:41:25Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- UpstreamHeartbeatManager detects silent SSE disconnects by pinging upstream MCP connections at configurable intervals
- Failure callback invoked on ping rejection with proper Error wrapping for non-Error rejections
- Idempotent start prevents duplicate timers; stopAll cleans up all connections
- CHANGELOG.md updated with upstream session foundation feature entry

## Task Commits

Each task was committed atomically:

1. **Task 1: UpstreamHeartbeatManager with TDD** - `4cc8ba8` (feat)
2. **Task 2: Update CHANGELOG.md** - `71ac81c` (chore)

## Files Created/Modified

- `src/upstream/upstream-heartbeat.ts` - UpstreamHeartbeatManager class with HeartbeatConfig, start/stop/stopAll/isRunning/getActiveCount
- `src/upstream/upstream-heartbeat.test.ts` - 21 tests covering interval pings, failure callbacks, cleanup, idempotency, custom config
- `CHANGELOG.md` - Added upstream session foundation entry under Unreleased

## Decisions Made

- Ping timeout delegated to caller via pingFn parameter rather than internal AbortController - keeps manager simple and lets MCP SDK handle its own timeout semantics
- Timer map keyed by string (sessionId:providerName) for flexible multi-connection support without coupling to specific ID types

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None - all implementations are complete and wired.

## Next Phase Readiness

- HeartbeatManager ready for integration into upstream connection manager
- getConfig() exposes timeoutMs for callers to pass to client.ping({ timeout })
- stopAll() ready for session cleanup lifecycle hooks

## Self-Check: PASSED

- All 3 created/modified files exist
- All 2 task commit hashes verified (4cc8ba8, 71ac81c)
- 21 tests passing
- Typecheck passes

---
*Phase: 01-upstream-session-foundation*
*Completed: 2026-03-27*
