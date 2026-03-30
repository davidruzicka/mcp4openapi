---
phase: 01-upstream-session-foundation
verified: 2026-03-27T06:49:28Z
status: gaps_found
score: 4/5 success criteria verified
gaps:
  - truth: "Client-supplied upstream credentials provided at session init are stored in session context and forwarded to upstream MCP server"
    status: failed
    reason: "extractUpstreamCredentials is never called from createSession in http-transport.ts. SessionData.upstreamCredentials is always undefined. getOrConnect is never called from production code yet (only in tests). Credentials cannot be forwarded because neither the extraction nor the forwarding path is wired into the live request flow."
    artifacts:
      - path: "src/upstream/upstream-credential-extractor.ts"
        issue: "ORPHANED - exported but never imported outside tests; not called during session initialization"
      - path: "src/upstream/upstream-credential-store.ts"
        issue: "ORPHANED - UpstreamCredentialStore never instantiated in production code path; only used in tests"
      - path: "src/types/http-transport.ts"
        issue: "SessionData.upstreamCredentials field defined but never populated - always undefined at runtime"
    missing:
      - "Call extractUpstreamCredentials(req.headers, allowedProviders) inside createSession in http-transport.ts and store result in SessionData.upstreamCredentials"
      - "Pass session upstreamCredentials to UpstreamConnectionManager.getOrConnect() when credentials are needed for upstream connection"
      - "Wire getOrConnect() call site for tool execution (tool proxy, Phase 2) to actually use the stored credentials"
---

# Phase 01: Upstream Session Foundation Verification Report

**Phase Goal:** A downstream client session can establish, maintain, and cleanly tear down a connection to an upstream HTTP MCP server using client-supplied credentials
**Verified:** 2026-03-27T06:49:28Z
**Status:** gaps_found
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | A downstream session lazily creates an upstream HTTP connection on first tool use, not at session initialization | VERIFIED | `UpstreamConnectionManager.getOrConnect()` checks `pendingConnections` and existing `CONNECTED` state; no connection created at session init. Wired to http-transport via `setUpstreamConnectionManager` which registers `onSessionDestroyed` listener. |
| SC2 | Client-supplied upstream credentials provided at session init are forwarded to the upstream MCP server and never appear in logs | FAILED | `extractUpstreamCredentials` is never called from `createSession`. `SessionData.upstreamCredentials` is always `undefined`. The credential store infrastructure exists but is fully disconnected from the session init path. |
| SC3 | Upstream connection failures produce typed MCP error responses with correlation IDs and no leaked credentials or stack traces | VERIFIED | 4 typed error classes extend `MCPError` with auto-generated correlation IDs. `toMcpErrorResponse` strips stack traces. `sanitizeAuthErrorMessage` applied to all messages. 16 tests confirm behavior. |
| SC4 | Inactive sessions are reaped and all upstream connections are closed; no connections leak on disconnect | VERIFIED | `closeAll` registered via `setUpstreamConnectionManager` -> `onSessionDestroyed` listener. Session reaper, DELETE /mcp, and shutdown all call `notifySessionDestroyed`. Transport close errors swallowed with `.catch()` to never break session destruction. |
| SC5 | Application-level heartbeat pings detect silent upstream SSE disconnects before a tool call fails | VERIFIED | `UpstreamHeartbeatManager.start()` uses `setInterval` with configurable interval (default 30s). Failure callback invoked on ping rejection. Idempotent start guards against duplicate timers. `stopAll()` for session cleanup. 21 tests pass with fake timers. |

**Score:** 4/5 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/upstream/upstream-errors.ts` | 4 typed error classes + toMcpErrorResponse | VERIFIED | 4 classes extend MCPError; correlationId in all; sanitizeAuthErrorMessage applied; toMcpErrorResponse returns `{ code: -32603, message, data: { correlationId, code } }` |
| `src/types/upstream-connection.ts` | UpstreamConnectionState, UpstreamConnection, UpstreamCredentials | VERIFIED | All 3 types exported; UpstreamConnection includes heartbeatTimer field |
| `src/upstream/upstream-credential-store.ts` | UpstreamCredentialStore + buildAuthHeaders | ORPHANED | Class fully implemented; buildAuthHeaders handles bearer/custom-header/query. Not imported in production code path - only tests. |
| `src/upstream/upstream-credential-extractor.ts` | extractUpstreamCredentials + UPSTREAM_AUTH_HEADER | ORPHANED | Fully implemented; correctly parses header; handles base64 tokens, multi-provider, unknown provider filtering. Not called from createSession. |
| `src/auth/auth-redaction.ts` | SECRET_FIELD_NAMES with upstream fields | VERIFIED | upstream_token, upstream_credentials, x-api-key, x_api_key, api_key added; Bearer pattern sanitization added |
| `src/types/http-transport.ts` | SessionData with upstreamCredentials field | STUB | Field `upstreamCredentials?: Map<string, string>` defined but never set in createSession; always undefined at runtime |
| `src/upstream/upstream-connection-manager.ts` | UpstreamConnectionManager with getOrConnect, closeAll | VERIFIED | Lazy connect, concurrent dedup via pendingConnections Map, closeAll swallows errors. Factory injection for testability. |
| `src/upstream/upstream-heartbeat.ts` | UpstreamHeartbeatManager with start/stop/isRunning | VERIFIED | Configurable interval/timeout, idempotent start, stopAll cleanup, delegated pingFn pattern |
| `src/transport/http-transport.ts` | setUpstreamConnectionManager wiring closeAll | VERIFIED | `setUpstreamConnectionManager` method adds `onSessionDestroyed` listener that calls `closeAll(sessionId).catch(...)` |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `upstream-errors.ts` | `src/core/errors.ts` | extends MCPError | WIRED | All 4 classes: `extends MCPError` confirmed |
| `upstream-connection-manager.ts` | `upstream-errors.ts` | throws typed errors | WIRED | UpstreamConnectionError, UpstreamTimeoutError, UpstreamAuthError imported and thrown from mapConnectError |
| `upstream-connection-manager.ts` | `upstream-credential-store.ts` | uses buildAuthHeaders | WIRED | `buildAuthHeaders` imported and called in `createConnection` to build requestInit.headers |
| `upstream-connection-manager.ts` | `upstream-errors.ts` | sanitizeAuthErrorMessage | WIRED | Imported from auth-redaction, applied in handleTransportError and mapConnectError |
| `http-transport.ts` | `upstream-connection-manager.ts` | closeAll via onSessionDestroyed | WIRED | setUpstreamConnectionManager registers listener; only import is `type` import (optional wiring by design) |
| `upstream-credential-extractor.ts` | `http-transport.ts` | populates SessionData.upstreamCredentials | NOT_WIRED | extractUpstreamCredentials never called from createSession; SessionData.upstreamCredentials always undefined |
| `upstream-credential-store.ts` | live request path | UpstreamCredentialStore instantiated per session | NOT_WIRED | Store never instantiated in production; only in unit tests |

---

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `SessionData.upstreamCredentials` | upstreamCredentials | Should come from X-Upstream-Authorization header via extractUpstreamCredentials | No - never set | DISCONNECTED |
| `UpstreamConnectionManager.getOrConnect` | credentials param (UpstreamCredentials) | Should come from session's upstreamCredentials | No - no production caller exists yet | DISCONNECTED |
| `buildAuthHeaders` | credentials.getToken(provider.name) | Should flow from credential store populated at session init | No - store never populated in production | DISCONNECTED |

---

## Behavioral Spot-Checks

| Behavior | Check | Result | Status |
|----------|-------|--------|--------|
| 88 upstream + redaction tests pass | `npx vitest run src/upstream/ src/auth/auth-redaction.test.ts` | 88 passed, 0 failed, 6 files | PASS |
| TypeScript compiles cleanly | `npm run typecheck` | No errors | PASS |
| 4 error classes extend MCPError | `grep -c "extends MCPError" src/upstream/upstream-errors.ts` | 4 | PASS |
| extractUpstreamCredentials wired to createSession | `grep "extractUpstreamCredentials" src/transport/http-transport.ts` | No matches | FAIL |
| upstreamCredentials populated at session init | `grep "upstreamCredentials" src/transport/http-transport.ts` | Only field declaration, never assigned | FAIL |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| PROXY-01 | 01-02-PLAN.md | Lazy upstream connection on first tool use | SATISFIED | getOrConnect creates connection only when called; no connection at session init |
| PROXY-02 | 01-01-PLAN.md | Client-supplied upstream credentials stored in session context and forwarded | BLOCKED | Infrastructure exists (extractor, store, SessionData field) but none of it is called from createSession or any live request handler. Credentials are never stored or forwarded. |
| REL-01 | 01-03-PLAN.md | Application-level heartbeat pings at configurable interval | SATISFIED | UpstreamHeartbeatManager with 30s default, failure callback, idempotent start |
| REL-02 | 01-02-PLAN.md | Session reaper closes upstream connections; no connection leaks | SATISFIED | closeAll wired to onSessionDestroyed; reaper/DELETE/shutdown all trigger cleanup |
| REL-03 | 01-01-PLAN.md | Typed error responses with correlation IDs; no stack traces or credential leakage | SATISFIED | 4 typed errors, toMcpErrorResponse strips stack, sanitizeAuthErrorMessage used throughout |
| SEC-02 | 01-01-PLAN.md | Upstream credentials redacted from logs, errors, diagnostics | SATISFIED | SECRET_FIELD_NAMES extended; Bearer pattern sanitization; token values never logged in extractor |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/upstream/upstream-connection-manager.ts` | 47-52 | Default clientFactory/transportFactory throw in production (no real defaults) | Warning | Production instantiation without injecting factories will throw immediately; by design for testability but undocumented constraint |
| `src/types/http-transport.ts` | 39 | `upstreamCredentials?: Map<string, string>` defined, never set | Blocker | PROXY-02 field exists but session init never populates it; always undefined at runtime |

---

## Human Verification Required

None - all automated checks were sufficient to determine status.

---

## Gaps Summary

One gap blocks full goal achievement: **PROXY-02 credential forwarding is infrastructure-only**.

The ROADMAP success criterion SC2 requires that credentials "provided at session init are stored in the session context and forwarded to the upstream MCP server." The phase built all required infrastructure:
- `extractUpstreamCredentials` correctly parses the `X-Upstream-Authorization` header
- `UpstreamCredentialStore` stores per-provider tokens
- `buildAuthHeaders` injects tokens into upstream request headers
- `SessionData.upstreamCredentials` field is declared

However, none of these are called from `createSession` in `http-transport.ts`. The plan 01-01 explicitly noted this wiring was "a separate concern for Phase 2 integration" - but PROXY-02 was declared complete in Phase 1 in both the SUMMARY and REQUIREMENTS.md.

The other 4 success criteria are fully implemented, tested, and wired:
- SC1/PROXY-01: Lazy connection via getOrConnect - verified
- SC3/REL-03: Typed errors with correlation IDs - verified
- SC4/REL-02: Session reaper closes upstream connections - verified
- SC5/REL-01: Heartbeat health monitoring - verified

The fix requires two targeted additions:
1. Call `extractUpstreamCredentials(req.headers, allowedProviders)` inside `createSession` and store the result in `SessionData.upstreamCredentials`
2. When `getOrConnect` is called (Phase 2 tool proxy), retrieve the session's `upstreamCredentials` and pass them as the `UpstreamCredentials` argument

---

_Verified: 2026-03-27T06:49:28Z_
_Verifier: Claude (gsd-verifier)_
