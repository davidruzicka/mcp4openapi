---
phase: 02-tool-discovery-and-call-proxy
verified: 2026-03-30T14:27:00Z
status: passed
score: 12/12 must-haves verified
re_verification: false
---

# Phase 02: Tool Discovery and Call Proxy Verification Report

**Phase Goal:** Wire upstream MCP server integration so that profiles with upstream_mcp forward tool discovery and invocation to upstream, with input sanitization and notification forwarding.
**Verified:** 2026-03-30T14:27:00Z
**Status:** passed
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | Tool names containing characters outside [a-zA-Z0-9_-] are dropped with a warning | VERIFIED | `TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/` in upstream-tool-sanitizer.ts:23; test passes |
| 2  | Tool descriptions containing <, >, or backtick are dropped with a warning | VERIFIED | `DESCRIPTION_FORBIDDEN_CHARS = /[<>\`]/` in sanitizer:24; 3 test cases pass |
| 3  | Safe tools pass through unchanged; only offending tools are dropped | VERIFIED | sanitizeToolList returns safe tools in `tools` field; mixed-list test passes |
| 4  | Notification queue buffers entries up to max size (50) and TTL (5 min) | VERIFIED | `DEFAULT_MAX_SIZE = 50`, `DEFAULT_TTL_MS = 300_000` in notification-queue.ts:24-25 |
| 5  | Queue evicts expired entries on push and respects size cap | VERIFIED | push() uses `Date.now()` for TTL filter then shift() for size cap; wall-clock test passes |
| 6  | Profile with both upstream_mcp and tools[] fails validation at load time | VERIFIED | `profile-loader.ts:84-89` throws ValidationError "mutually exclusive"; 3 tests pass |
| 7  | tools/list request with upstream_mcp returns upstream server tools, sanitized | VERIFIED | handleUpstreamToolsList in mcp-server.ts:1721; calls `client.listTools()` then `sanitizeToolList`; test passes |
| 8  | tools/call request with upstream_mcp forwards to upstream server | VERIFIED | handleUpstreamToolCall in mcp-server.ts:1758; calls `client.callTool()`; test passes |
| 9  | Upstream tool-level errors (isError: true) are forwarded as-is | VERIFIED | mcp-server.ts:1778 comment + test "forwards isError:true results as-is" passes |
| 10 | Upstream protocol errors map to typed MCP error codes | VERIFIED | DATA_DRIVEN_MAPPINGS in mcp-server.ts:100; instanceof dispatch; 3 error-type tests pass |
| 11 | When upstream sends tools/list_changed, downstream SSE receives it | VERIFIED | handleUpstreamNotification checks hasActiveStreamFn then calls downstreamNotifyFn; wired in http-transport.ts:3541 |
| 12 | Notifications buffered when SSE disconnected, replayed on reconnect | VERIFIED | Per-session NotificationQueue in upstream-connection-manager.ts:56; drainNotifications called in http-transport.ts:3163 on SSE connect |

**Score:** 12/12 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/upstream/upstream-tool-sanitizer.ts` | sanitizeToolList with data-driven allowlists | VERIFIED | 72 lines; exports sanitizeToolList + SanitizationResult; constants not exported |
| `src/upstream/upstream-tool-sanitizer.test.ts` | Unit tests (min 60 lines) | VERIFIED | 168 lines; 18 tests including boundary cases at 2048/2049 chars and 100-char truncation |
| `src/upstream/upstream-notification-queue.ts` | NotificationQueue with bounded size and TTL | VERIFIED | 71 lines; exports NotificationQueue + NotificationQueueEntry + NotificationQueueOptions |
| `src/upstream/upstream-notification-queue.test.ts` | Unit tests (min 50 lines) | VERIFIED | 134 lines; 13 tests including fake-timer wall-clock TTL test |
| `src/mcp/mcp-server.ts` | handleUpstreamToolsList + handleUpstreamToolCall methods | VERIFIED | Both methods present; UPSTREAM_ERROR_MAP as DATA_DRIVEN_MAPPINGS; all key patterns found |
| `src/mcp/mcp-server.ts` | mapUpstreamErrorToMcpError data-driven mapping | VERIFIED | function at line 96; DATA_DRIVEN_MAPPINGS array at line 100; instanceof dispatch |
| `src/upstream/upstream-connection-manager.ts` | Per-session NotificationQueue + notification listener wiring | VERIFIED | notificationQueues Map at line 56; static NOTIFICATION_DISPATCH at line 73; wireNotificationListeners at line 189 |
| `src/transport/http-transport.ts` | Queue flush on SSE reconnect + hasActiveStream callback | VERIFIED | drainNotifications call at line 3163; hasActiveStream at line 3564; findProfileIdForSession at line 3581 |
| `CHANGELOG.md` | User-facing changelog entry mentioning upstream | VERIFIED | Line 11: single compressed entry covering tools/list, tools/call, sanitization, notification relay, replay on reconnect |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| upstream-tool-sanitizer.ts | mcp-server.ts | import sanitizeToolList | WIRED | mcp-server.ts:54 `import { sanitizeToolList }` |
| upstream-tool-sanitizer.ts result | handleUpstreamToolsList | sanitized.tools in response | WIRED | mcp-server.ts:1737-1741: `sanitizeToolList(result.tools ?? [], ...)` -> `result: { tools: sanitized.tools }` |
| upstream-notification-queue.ts | upstream-connection-manager.ts | import NotificationQueue | WIRED | upstream-connection-manager.ts:25 `import { NotificationQueue }` |
| upstream-connection-manager.ts | MCP SDK Client | setNotificationHandler on upstream client | WIRED | upstream-connection-manager.ts:191 `client.setNotificationHandler(schema, ...)` |
| upstream-connection-manager.ts | http-transport.ts | setDownstreamNotifyFn + setHasActiveStreamFn callbacks | WIRED | http-transport.ts:3536-3551 wires both callbacks in setUpstreamConnectionManager |
| http-transport.ts | upstream-connection-manager.ts | drainNotifications on SSE reconnect | WIRED | http-transport.ts:3163 `this.upstreamConnectionManager.drainNotifications(sessionId)` |
| mcp-server.ts | upstream-connection-manager.ts | getOrConnect via getUpstreamClientFn callback | WIRED | mcp-server.ts:1735 calls `this.getUpstreamClientFn!(sessionId, provider, token)` |
| mcp-server.ts | upstream-errors.ts | instanceof checks in mapUpstreamErrorToMcpError | WIRED | mcp-server.ts:100-121; UpstreamConnectionError, UpstreamTimeoutError, UpstreamAuthError, UpstreamMalformedResponseError all checked |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| handleUpstreamToolsList | `result.tools` | `client.listTools()` call to upstream MCP Client | Yes - live RPC to upstream | FLOWING |
| handleUpstreamToolCall | `result` from `client.callTool()` | live RPC to upstream MCP Client | Yes - live RPC | FLOWING |
| handleUpstreamNotification | notification params from upstream | `setNotificationHandler` listener on upstream MCP Client | Yes - event-driven from upstream | FLOWING |
| drainNotifications flush (SSE reconnect) | buffered NotificationQueueEntry[] | per-session NotificationQueue populated by handleUpstreamNotification | Yes - replays buffered real notifications | FLOWING |

### Behavioral Spot-Checks

| Behavior | Check | Status |
|----------|-------|--------|
| sanitizeToolList drops invalid tool names | vitest run upstream-tool-sanitizer.test.ts (18 tests) | PASS - all 18 tests green |
| NotificationQueue wall-clock TTL eviction | vitest run upstream-notification-queue.test.ts (13 tests) | PASS - all 13 tests green |
| Profile mutual exclusivity validation | vitest run profile-loader.test.ts -t "mutual exclusiv" (3 tests) | PASS - all 3 tests green |
| tools/list + tools/call upstream proxy | vitest run mcp-server.test.ts -t "upstream" (14 tests) | PASS - all 14 tests green |
| notification forwarding + queue management | vitest run upstream-connection-manager.test.ts -t "notification" (8 tests) | PASS - all 8 tests green |
| TypeScript compilation | npm run typecheck | PASS - 0 errors |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| PROXY-03 | 02-01, 02-02 | tools/list returns upstream tool list for profiles with upstream_mcp | SATISFIED | handleUpstreamToolsList calls client.listTools(); test "returns sanitized upstream tools when upstream_mcp configured" passes |
| PROXY-04 | 02-02 | tools/call routed to upstream MCP server with typed error mapping | SATISFIED | handleUpstreamToolCall calls client.callTool(); DATA_DRIVEN_MAPPINGS handles all error types; test suite confirms |
| SEC-01 | 02-01, 02-02 | Tool definitions sanitized against safe-string allowlist before forwarding | SATISFIED | sanitizeToolList drops names outside [a-zA-Z0-9_-] and descriptions with <, >, backtick; 18 unit tests; called in handleUpstreamToolsList |
| REL-04 | 02-01, 02-03 | tools/list_changed forwarded to downstream SSE; queued and replayed if no stream | SATISFIED | ToolListChangedNotificationSchema handler wired on upstream client; per-session NotificationQueue; drainNotifications on SSE reconnect; 8 tests pass |

All 4 requirement IDs from PLAN frontmatter accounted for. No orphaned requirements for Phase 2 found in REQUIREMENTS.md.

### Anti-Patterns Found

No anti-patterns found. Scanned all phase 2 key files:

- `src/upstream/upstream-tool-sanitizer.ts` - clean implementation, data-driven constants
- `src/upstream/upstream-notification-queue.ts` - clean implementation, Date.now() TTL
- `src/mcp/mcp-server.ts` (upstream sections) - no TODO/FIXME/placeholder comments
- `src/upstream/upstream-connection-manager.ts` - explicit hasActiveStreamFn check (not exception-as-control-flow)
- `src/transport/http-transport.ts` (upstream sections) - flush wired at SSE connect path

### Human Verification Required

#### 1. End-to-End Notification Delivery

**Test:** Start the gateway with an HTTP transport profile pointing to a live upstream MCP server that emits tools/list_changed. Connect a downstream SSE client, trigger a tool list change on upstream, observe the notification arrives at the downstream client in real-time.
**Expected:** Downstream SSE client receives `{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}` within the network round-trip time.
**Why human:** Requires a live upstream MCP server and an active SSE connection - not testable without running infrastructure.

#### 2. Queue Replay on Reconnect

**Test:** Connect to an upstream MCP server, disconnect the downstream SSE stream, trigger a tools/list_changed on upstream, reconnect the SSE stream, observe the buffered notification is replayed.
**Expected:** On SSE reconnect, the buffered notification appears in the stream before any new real-time events.
**Why human:** Requires controlled disconnect/reconnect cycle with timing control over upstream notification.

#### 3. stdio Transport Warning

**Test:** Run the gateway in stdio transport mode with a profile that has upstream_mcp configured, issue a tools/list request.
**Expected:** A warning log appears: "upstream_mcp configured but no upstream client wired - upstream_mcp requires HTTP transport". The request does not crash.
**Why human:** Requires running the gateway in stdio mode and inspecting log output.

### Gaps Summary

No gaps. All phase 2 must-haves verified:

- Plan 02-01: Tool sanitizer, notification queue, and profile mutual-exclusivity validation all implemented with full unit test coverage.
- Plan 02-02: tools/list and tools/call proxy handlers wired in mcp-server.ts with data-driven error mapping, sessionId guards, and listChanged capability advertisement.
- Plan 02-03: Notification forwarding fully wired from upstream MCP Client through UpstreamConnectionManager to downstream SSE via HttpTransport; bounded queue buffering and replay on reconnect operational; CHANGELOG.md updated.

---

_Verified: 2026-03-30T14:27:00Z_
_Verifier: Claude (gsd-verifier)_
