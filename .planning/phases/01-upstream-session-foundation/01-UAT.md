---
status: complete
phase: 01-upstream-session-foundation
source: [01-01-SUMMARY.md, 01-02-SUMMARY.md, 01-03-SUMMARY.md]
started: 2026-03-27T07:00:00Z
updated: 2026-03-29T00:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. X-Upstream-Authorization header parsing
expected: |
  extractUpstreamCredentials parses a header like
  "X-Upstream-Authorization: github=ghp_token123,gitlab=glpat_abc"
  into a Map with provider keys and token values.
  Multiple providers work. Unknown providers are filtered if allowedProviders is set.
  A missing header returns undefined gracefully (no error thrown).
result: issue
reported: "Every upstream mcp is isolated in its own profile - client sets his url mcp like https://mcp4openapi.local/profile/github-proxy/mcp and in headers it can set direct Authorization: Bearer ${input:github-token}. X-Upstream-Authorization is not required because we aren't creating aggregation-like mcp server."
severity: major

### 2. Auth header builder produces correct format
expected: |
  buildAuthHeaders given a bearer token produces {"Authorization": "Bearer <token>"}.
  Given a custom-header config produces the custom header name with the token value.
  No extra headers are added beyond what the auth config specifies.
result: pass

### 3. Token redaction in logs
expected: |
  Fields named "upstream_token", "x_api_key", and "api_key" are redacted in log output.
  A Bearer token pattern in an error message is stripped — only "Bearer [REDACTED]" remains.
  Provider names (e.g. "github") are NOT redacted, only the token values.
result: issue
reported: "Full redaction loses diagnostic value. Partial suffix like Bearer [REDACTED]...xQ5g would help identify which token is in use without exposing it."
severity: minor

### 4. Typed upstream errors carry correlation IDs
expected: |
  UpstreamConnectionError, UpstreamTimeoutError, UpstreamAuthError each have a correlationId field.
  toMcpErrorResponse returns a safe MCP error shape without stack traces.
  sanitizeAuthErrorMessage strips long Bearer token strings from error messages.
result: pass

### 5. Lazy upstream connection — no connection at session init
expected: |
  UpstreamConnectionManager.getOrConnect creates the upstream MCP client only on the FIRST call,
  not when the manager is instantiated. Before any getOrConnect call, getActiveSessionCount returns 0
  and getConnection returns undefined for any sessionId.
result: issue
reported: "No early auth validation at session init - upstream token validity only surfaces on first tool call. User suggests validation_endpoint in profile config to fail fast with a clean auth error during initialize."
severity: minor

### 6. Concurrent getOrConnect deduplication
expected: |
  Two simultaneous getOrConnect calls for the same sessionId+providerName result in only ONE
  upstream client being created (the second awaits the first's promise rather than starting a
  parallel connection). The clientFactory is called exactly once.
result: pass

### 7. Session cleanup closes upstream connections
expected: |
  After setUpstreamConnectionManager is called on HttpTransport and a session is destroyed
  (via reaper timeout, DELETE /mcp, or server shutdown), closeAll is invoked for that session.
  Errors from transport.close are caught and logged — they do NOT propagate to break session destruction.
result: pass

### 8. Heartbeat pings fire at configured interval
expected: |
  UpstreamHeartbeatManager.start(sessionId, providerName, pingFn, config) triggers pingFn at
  every intervalMs. isRunning returns true after start, false after stop.
  A second start call for the same key is a no-op (idempotent — no duplicate timers).
  stopAll() cancels all active timers.
result: pass

### 9. Heartbeat failure callback invoked on ping rejection
expected: |
  When pingFn rejects, the onFailure callback is called with an Error instance.
  Non-Error rejections (bare strings, objects) are wrapped in Error before being passed to onFailure.
  The heartbeat timer continues running after failure (does not auto-stop).
result: pass

## Summary

total: 9
passed: 6
issues: 3
pending: 0
skipped: 0
blocked: 0

## Gaps

- truth: "Upstream MCP credential delivery uses the standard Authorization: Bearer header — each upstream MCP is isolated in its own profile (e.g. /profile/github-proxy/mcp), so the client just sends a direct Authorization header. No multi-provider X-Upstream-Authorization header is needed."
  status: failed
  reason: "User reported: Every upstream mcp is isolated in its own profile - client sets his url mcp like https://mcp4openapi.local/profile/github-proxy/mcp and in headers it can set direct Authorization: Bearer. X-Upstream-Authorization is not required because we aren't creating aggregation-like mcp server."
  severity: major
  test: 1
  artifacts: [src/upstream/upstream-credential-extractor.ts, src/upstream/upstream-credential-store.ts]
  missing: []

- truth: "No early auth validation at session init - upstream token validity only surfaces on first tool call. Profile should support an optional validation_endpoint to fail fast with a clean UpstreamAuthError during initialize."
  status: failed
  reason: "User reported: missing authentication validation info for client when authentication invalid. Suggested validation_endpoint variant in mcp profile."
  severity: minor
  test: 5
  artifacts: [src/upstream/upstream-connection-manager.ts, src/types/upstream-connection.ts]
  missing: [upstream.validation_endpoint profile field, early auth check in session init path]

- truth: "Bearer token redaction in logs should preserve a short suffix (last 4 chars) for diagnostic identity, e.g. Bearer [REDACTED]...xQ5g, rather than full erasure."
  status: failed
  reason: "User reported: Full redaction loses diagnostic value. Partial suffix like Bearer [REDACTED]...xQ5g would help identify which token is in use without exposing it."
  severity: minor
  test: 3
  artifacts: [src/auth/auth-redaction.ts]
  missing: []
