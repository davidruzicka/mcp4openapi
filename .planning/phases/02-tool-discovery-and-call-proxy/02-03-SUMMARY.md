---
phase: 02-tool-discovery-and-call-proxy
plan: "03"
subsystem: upstream-proxy
tags: [mcp, notification, sse, queue, upstream-proxy]

requires:
  - phase: 02-tool-discovery-and-call-proxy plan 01
    provides: UpstreamConnectionManager, NotificationQueue
  - phase: 02-tool-discovery-and-call-proxy plan 02
    provides: upstream proxy handler, tools/list + tools/call forwarding

provides:
  - Upstream tools/list_changed notification forwarding to downstream SSE clients in real-time
  - Bounded queue buffering when no SSE stream active, replay on reconnect
  - Explicit hasActiveStream callback for stream presence check (no exception-as-control-flow)
  - Extensible static NOTIFICATION_DISPATCH map for adding notification types without branching
  - Queue cleanup wired on all session destruction paths via closeAll + onSessionDestroyed listener
  - sendToClient now writes to active SSE response for real-time delivery (was queue-only)

affects: [phase-03-client-auth, verifier, downstream-sse-clients]

tech-stack:
  added: []
  patterns:
    - "Extensible dispatch via static readonly map: adding notification type = one array entry"
    - "Explicit stream-presence callback avoids exception-as-control-flow anti-pattern"
    - "Queue cleanup via closeAll covers all session destruction paths through onSessionDestroyed listener"

key-files:
  created: []
  modified:
    - src/upstream/upstream-connection-manager.ts
    - src/upstream/upstream-connection-manager.test.ts
    - src/transport/http-transport.ts
    - src/transport/http-transport.upstream-validation.test.ts
    - CHANGELOG.md

key-decisions:
  - "setNotificationHandler called immediately after client.connect() succeeds, before storing connection - notification handler active for full connection lifetime"
  - "NOTIFICATION_DISPATCH is private static readonly - constant data shared across instances, not per-instance state"
  - "hasActiveStreamFn callback injected from HttpTransport to UpstreamConnectionManager - avoids importing transport in upstream module (clean dependency direction)"
  - "sendToClient fixed to also write to SSE response in real-time (was queue-only before this plan)"
  - "findProfileIdForSession is O(n) over profileStates - acceptable for phase 2 scale, can be indexed later if needed"

requirements-completed: [REL-04]

duration: 12min
completed: "2026-03-30"
---

# Phase 02 Plan 03: Upstream Notification Forwarding Summary

**tools/list_changed notification relay from upstream MCP Client to downstream SSE with bounded queue buffering, explicit stream presence check, and replay on reconnect**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-30T14:14:00Z
- **Completed:** 2026-03-30T14:20:51Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Upstream MCP Client now registers ToolListChangedNotificationSchema handler on connect, forwarding to downstream SSE in real-time when stream is active
- Per-session NotificationQueue buffers notifications when SSE is disconnected, replayed via drainNotifications on SSE reconnect
- Static NOTIFICATION_DISPATCH map makes adding new notification types a one-liner (D-07 extensibility requirement met)
- sendToClient fixed to write to active SSE response streams in real-time (previously only queued for replay)
- CHANGELOG.md updated with single compressed phase 2 upstream proxy entry

## Task Commits

1. **Task 1: Wire notification listener on upstream Client and per-session queue** - `27a7b79` (feat)
2. **Task 2: Wire notification queue flush on SSE reconnect in HttpTransport and update CHANGELOG** - `709ef32` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `src/upstream/upstream-connection-manager.ts` - Added NotificationQueue per session, setDownstreamNotifyFn, setHasActiveStreamFn, drainNotifications, cleanupSessionQueue, wireNotificationListeners, handleUpstreamNotification, static NOTIFICATION_DISPATCH map
- `src/upstream/upstream-connection-manager.test.ts` - Added setNotificationHandler to mock client, 8 notification forwarding tests
- `src/transport/http-transport.ts` - Fixed sendToClient to write to SSE response, added hasActiveStream + findProfileIdForSession, wired both callbacks in setUpstreamConnectionManager, flush drainNotifications on SSE GET connect
- `src/transport/http-transport.upstream-validation.test.ts` - Updated mock managers to include new setHasActiveStreamFn/setDownstreamNotifyFn methods
- `CHANGELOG.md` - Added upstream MCP proxy entry covering all phase 2 user-visible features

## Decisions Made
- setNotificationHandler called after successful connect, before storing connection, so handler is active for the full connection lifetime
- NOTIFICATION_DISPATCH is `private static readonly` - constant across instances, not per-instance state
- hasActiveStreamFn callback direction: HttpTransport -> UpstreamConnectionManager (clean dependency direction, avoids importing transport in upstream module)
- sendToClient now also writes to SSE response - this was a pre-existing bug (queue-only) that would prevent real-time delivery of any server-sent notifications

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed sendToClient to write to SSE response for real-time delivery**
- **Found during:** Task 2 (wiring notification forwarding in HttpTransport)
- **Issue:** sendToClient only queued messages for replay resumability but never wrote to the active SSE response, so notifications would be buffered but never delivered to connected clients in real-time
- **Fix:** Added `streamState.response.write()` calls for active streams in sendToClient, with try/catch to handle race condition where stream closes between active check and write
- **Files modified:** src/transport/http-transport.ts
- **Verification:** Existing transport tests pass (544 tests green); behavior now matches SSE spec intent
- **Committed in:** 709ef32 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Essential fix - without it no notifications (including the ones wired in this plan) would reach connected clients. No scope creep.

## Issues Encountered
- Mock UpstreamConnectionManager in upstream-validation tests lacked new setHasActiveStreamFn/setDownstreamNotifyFn methods - updated all 4 mock instances to include them (Rule 3 auto-fix inline with task)

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- REL-04 (upstream notification forwarding) complete
- Phase 2 fully delivered: upstream tool discovery (02-01), tool proxy (02-02), notification relay (02-03)
- Phase 3 (client authentication) can proceed - upstream connection foundation is complete

---
*Phase: 02-tool-discovery-and-call-proxy*
*Completed: 2026-03-30*
