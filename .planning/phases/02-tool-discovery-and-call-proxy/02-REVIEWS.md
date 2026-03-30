---
phase: 2
reviewers: [claude-self]
reviewed_at: 2026-03-30T13:18:04Z
plans_reviewed: [02-01-PLAN.md, 02-02-PLAN.md, 02-03-PLAN.md]
note: External CLIs unavailable (claude CLI not authenticated, gemini/codex not installed). In-session structured review performed instead.
---

# Cross-AI Plan Review - Phase 2: Tool Discovery and Call Proxy

## Claude Review

### Summary

The three-plan wave decomposition is well-structured: foundation modules first (02-01), integration second (02-02), notification wiring last (02-03). The plans are specific, provide real code snippets, and reference concrete line numbers. The overall approach is sound and achievable within the phase boundary.

Three areas warrant attention: (1) a logic concern in Plan 02-01's notification queue TTL eviction (`entry.timestamp - e.timestamp` uses the incoming entry's timestamp, which is correct for relative age but fails when entries use arbitrary or injected timestamps); (2) the `handleUpstreamNotification` fallback-to-queue behavior in Plan 02-03 relies on `downstreamNotifyFn` throwing exceptions to detect "no stream" - this is fragile and introduces a control-flow anti-pattern; (3) Plan 02-02 injects a `getUpstreamMcpConfig` helper on `McpServer` but its stdio path reads `this.profile?.upstream_mcp` directly - this path is untested and bypasses the `getOrConnect` credential token plumbing.

---

### Plan 02-01: Tool Sanitizer, Notification Queue, Profile Mutual-Exclusivity

**Strengths**
- Data-driven allowlists (`TOOL_NAME_PATTERN`, `DESCRIPTION_FORBIDDEN_CHARS`) avoid future branching chains
- Drop-and-warn per D-05 is operationally correct; partial list is better than total failure
- NotificationQueue is a clean, minimal data structure
- Mutual-exclusivity check after `resolveUpstreamMcpConfig` (not before) is correctly ordered
- Length limits (255 / 2048) are stated upfront with explicit reasons
- Test coverage expectations are concrete (min line counts, specific behavior assertions)

**Concerns**
- [MEDIUM] TTL eviction logic: `(entry.timestamp - e.timestamp) < this.ttlMs` computes age relative to the **incoming** entry's timestamp, not `Date.now()`. If `entry.timestamp` is far in the future (clock skew, mocked time), this can retain stale entries. The idiomatic approach uses `Date.now()` at eviction time: `now - e.timestamp < this.ttlMs`. Low risk in practice but a footgun in tests using `vi.useFakeTimers()` where the incoming timestamp may not equal "now".
- [MEDIUM] Tool sanitizer `dropped[].name` returns the raw upstream name. For description failures, the reported `name` could itself contain injection characters. The name should be truncated before logging/returning in `dropped[].name` to avoid logging injected content.
- [LOW] No explicit test for description length exactly at boundary (2048 chars should pass; 2049 should drop). Plans mention "exceeding" but boundary equality behavior should be explicit.

**Suggestions**
- In `NotificationQueue.push`, use `const now = Date.now()` for TTL comparison: `this.entries.filter(e => (now - e.timestamp) < this.ttlMs)`
- In `SanitizationResult.dropped[].name`, truncate the raw upstream name (e.g., `.slice(0, 100)`) before including it
- Add explicit test for description length === MAX_DESCRIPTION_LENGTH (should pass) and MAX_DESCRIPTION_LENGTH + 1 (should drop)

**Risk Assessment: LOW** - Foundation modules are isolated and fully testable. The TTL issue is a minor logic concern that tests should catch.

---

### Plan 02-02: Upstream tools/list and tools/call Handler Wiring

**Strengths**
- Callback injection (`setGetUpstreamClient`) correctly avoids tight coupling to `UpstreamConnectionManager`
- `instanceof` for error mapping (not `constructor.name`) explicitly avoids a real pitfall
- `DATA_DRIVEN_MAPPINGS` table pattern is correct for error dispatch
- Forwarding `isError: true` as-is correctly follows MCP spec - a non-obvious distinction the plan gets right
- Capabilities `listChanged: true` explicit - required for proper downstream behavior
- `getUpstreamToken` using existing `getSessionToken` avoids duplicating session credential access

**Concerns**
- [HIGH] `handleUpstreamToolsList` uses `sessionId!` (non-null assertion). For stdio transport, `sessionId` may be undefined. If `getOrConnect` requires a non-undefined sessionId, this throws at runtime for stdio upstream profiles. Guard or document that upstream_mcp is HTTP-transport-only.
- [HIGH] `getUpstreamMcpConfig` stdio path reads `this.profile?.upstream_mcp` but `getUpstreamClientFn` is only wired in `http-transport.ts`. Result: `upstreamMcp?.length` is truthy but `getUpstreamClientFn` is null, so the guard correctly prevents the upstream call. Stdio upstream profiles are silently ignored. This should emit a typed error or clear warning, not a silent no-op.
- [MEDIUM] `mapUpstreamErrorToMcpError` includes `providerName` in the client-facing error message string. For a security-boundary gateway, infrastructure names (internal service names) should not leak to downstream clients. Move to `data.providerName` (operator-side) or server-side logs only.
- [MEDIUM] No test for `getOrConnect` itself throwing inside `handleUpstreamToolsList`. Error mapping tests cover post-`callTool` throws but not connection establishment failures.
- [LOW] `UpstreamTimeoutError` maps to `-32001` (non-standard code). Should be defined as a named constant with documentation if intentional.

**Suggestions**
- Add guard before upstream call: `if (!sessionId) { throw new UpstreamConnectionError('upstream_mcp requires a session context (HTTP transport only)') }`
- Move `providerName` from error message to `data.providerName`, or document the deployment decision explicitly
- Add test for `getOrConnect` throwing `UpstreamConnectionError` inside `handleUpstreamToolsList`
- Define `const MCP_TIMEOUT_ERROR_CODE = -32001` with a comment on the deliberate choice

**Risk Assessment: MEDIUM** - The sessionId non-null assertion and stdio silent-ignore are latent bugs. Provider name in client-facing error message is a security concern for a gateway.

---

### Plan 02-03: Notification Forwarding from Upstream to Downstream SSE

**Strengths**
- `NOTIFICATION_DISPATCH` class-level array satisfies D-07 (extensibility) - adding new notification types is a one-liner
- Cleaning up queues in `closeAll` prevents memory leaks - explicitly called out
- `findProfileIdForSession` O(n) with explicit acknowledgment of the trade-off for current scale
- Including `params` when forwarding (not stripping) is correct for future extension
- JSON-RPC notification format (no `id`) is correctly specified
- `drainNotifications` on reconnect is the right integration point

**Concerns**
- [HIGH] Exception-as-control-flow: `handleUpstreamNotification` catches `downstreamNotifyFn()` throwing to detect "no active SSE stream". This relies on `sendToClient` throwing when no stream is active - not a stated contract. If `sendToClient` is ever changed to silently no-op, notifications will stop being queued without error. Replace with an explicit `hasActiveStream(profileId, sessionId)` check.
- [HIGH] If `findProfileIdForSession` returns `undefined` (session already destroyed), the callback throws, notification is buffered - but buffering for a destroyed session means `notificationQueues` grows until `closeAll` is called. The queue cleanup in `closeAll` must be called on ALL session destruction paths (timeout, eviction, explicit close, transport shutdown).
- [MEDIUM] `NOTIFICATION_DISPATCH` is declared as a class property (instance-level) but is functionally static constant data. Should be `static readonly` to avoid per-instance allocation.
- [MEDIUM] No tests specified for the HttpTransport-side changes: queue drain on SSE reconnect, `findProfileIdForSession`, `setDownstreamNotifyFn` wiring. Only `upstream-connection-manager.test.ts` tests are called out.
- [LOW] `typeof ToolListChangedNotificationSchema` as the dispatch array element type hardcodes the schema type. A more generic type (SDK's `NotificationSchema` or `ZodSchema`) would be more extensible for future notification types.

**Suggestions**
- Replace exception-based detection with explicit stream presence check: wire a `hasActiveStream(sessionId) => boolean` callback instead of relying on `sendToClient` throwing
- Make `NOTIFICATION_DISPATCH` `static readonly`
- Add tests for HttpTransport notification queue drain on SSE reconnect (even as integration-level test stubs)
- Audit all session destruction paths and confirm `closeAll` (or equivalent queue cleanup) is called in each

**Risk Assessment: MEDIUM** - The exception-as-control-flow pattern is fragile. The session-destruction queue cleanup dependency is a potential memory leak. Both are addressable before implementation.

---

## Consensus Summary

### Agreed Strengths
- Wave decomposition is well-ordered: foundation before integration before forwarding
- Data-driven dispatch patterns used throughout (sanitizer allowlists, notification dispatch map, error mapping table)
- MCP protocol nuances correctly handled: `isError: true` forwarded as-is, capabilities `listChanged: true`, JSON-RPC notification without `id`
- Existing typed error infrastructure reused correctly

### Top Concerns

1. **[HIGH] Exception-as-control-flow for SSE stream detection** (Plan 02-03): `handleUpstreamNotification` catches `sendToClient` throwing to detect "no stream" - fragile contract. Replace with explicit stream presence check.

2. **[HIGH] `sessionId` non-null assertion in upstream handlers** (Plan 02-02): `sessionId!` in `handleUpstreamToolsList` and `handleUpstreamToolCall` will throw for stdio transport. Guard or document constraint.

3. **[MEDIUM] Provider name in client-facing error messages** (Plan 02-02): `mapUpstreamErrorToMcpError` includes `providerName` in the message string. Move to server-side only for a security-boundary gateway.

4. **[MEDIUM] TTL eviction uses incoming timestamp instead of `Date.now()`** (Plan 02-01): Minor logic issue in `NotificationQueue.push` - use `const now = Date.now()` for age comparison.

5. **[MEDIUM] Missing tests for HttpTransport notification wiring** (Plan 02-03): SSE drain-on-reconnect behavior is unverified.

### Divergent Views
N/A - single reviewer session.
