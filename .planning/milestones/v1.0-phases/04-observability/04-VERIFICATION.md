---
phase: 04-observability
verified: 2026-05-11T14:00:00Z
status: gaps_found
score: 9/14 must-haves verified
gaps:
  - truth: "extractHost normalizes to lowercase hostname only (no port, no path, no credentials); falls back to 'unknown' on invalid URL"
    status: failed
    reason: "extractHost uses .host (includes port e.g. 'host:8080') instead of .hostname (no port). Falls back to original string ('not-a-url') instead of 'unknown' on invalid URL."
    artifacts:
      - path: "src/mcp/mcp-server.ts"
        issue: "Line 108: uses new URL(url).host (includes port) instead of .hostname. Line 110: returns url (original string) instead of 'unknown' on catch."
    missing:
      - "Change .host to .hostname on line 108"
      - "Change 'return url' to 'return \"unknown\"' on line 110"
      - "Update extractHost tests in mcp-server.test.ts: line 5732 expects 'localhost:8080', should be 'localhost'; line 5736 expects 'not-a-url', should be 'unknown'"

  - truth: "Stdio path audit log uses sessionId='stdio' (named sentinel, not null)"
    status: failed
    reason: "Stdio path passes sessionId: undefined to emitAuditToolCall, which coalesces to null (args.sessionId ?? null at line 2267). Comment at line 1029 explicitly says 'sessionId=null and clientPrincipal=anonymous'. Tests assert sessionId: null."
    artifacts:
      - path: "src/mcp/mcp-server.ts"
        issue: "Lines 1031 and 1054: sessionId: undefined instead of 'stdio' or a named STDIO_SESSION_ID constant. emitAuditToolCall coerces undefined to null at line 2267."
      - path: "src/mcp/mcp-server.test.ts"
        issue: "Line 5791: test asserts sessionId: null, which matches current buggy behavior not the plan requirement."
    missing:
      - "Define STDIO_SESSION_ID = 'stdio' as const"
      - "Pass sessionId: STDIO_SESSION_ID at lines 1031 and 1054"
      - "Update emitAuditToolCall type: sessionId: string | undefined -> string | null (or keep undefined but remove ?? null coalesce)"
      - "Update test at line 5791 to expect sessionId: 'stdio'"

  - truth: "Every tools/call emits a logger.info('audit:tool_call', ...) entry with sessionId, clientPrincipal, tool, upstreamHost, outcome, durationMs, and correlationId"
    status: failed
    reason: "emitAuditToolCall logs sessionId, clientPrincipal, tool, upstreamHost, outcome, durationMs - but does NOT include correlationId. The plan explicitly listed correlationId as a required field."
    artifacts:
      - path: "src/mcp/mcp-server.ts"
        issue: "emitAuditToolCall (lines 2254-2274): no correlationId field in the logger.info payload. The helper signature also lacks correlationId."
    missing:
      - "Add correlationId parameter to emitAuditToolCall args interface"
      - "Include correlationId in the logger.info payload at line 2266"
      - "Pass correlationId from handleToolCall entry point to emitAuditToolCall call sites"

  - truth: "normalizePath treats /ready as a known path (no high-cardinality label in Prometheus)"
    status: partial
    reason: "/ready IS in the normalizePath allowlist (lines 429-433), so /ready requests return '/ready' as the path label. However, the dead-else bug was NOT fixed: any unknown path still returns the raw path string (line 436: 'return pathWithoutQuery'). High-cardinality paths like session IDs or dynamic URL segments will pollute Prometheus labels. The plan's action explicitly required fixing the dead-else to return 'other'."
    artifacts:
      - path: "src/core/metrics.ts"
        issue: "Line 436: 'return pathWithoutQuery' should be 'return \"other\"' to cap cardinality for unknown paths. The test at metrics.test.ts:392 still asserts path=\"/unknown/path\" (old behavior)."
    missing:
      - "Change line 436 from 'return pathWithoutQuery' to 'return \"other\"'"
      - "Update metrics.test.ts line 392: expect(output).toContain('path=\"other\"') instead of path=\"/unknown/path\""

  - truth: "/ready route handler contains a comment noting it is a shallow check (profile count only, not upstream probe)"
    status: failed
    reason: "The /ready route has comments about it being a readiness probe and unauthenticated, but does NOT contain the required 'shallow check' language or the explicit note about not probing upstream connectivity."
    artifacts:
      - path: "src/transport/http-transport.ts"
        issue: "Lines 1661-1664 comment does not include 'shallow check', 'profile count only', or 'not upstream probe' phrasing."
    missing:
      - "Add comment inside the /ready handler body: '// Shallow readiness check: verifies at least one profile is loaded; does not probe upstream connectivity, spec parsing, or auth token presence.'"
human_verification: []
---

# Phase 04: Observability Verification Report

**Phase Goal:** Every tool call is audited with identity and outcome; operators have metrics and health endpoints to monitor the gateway
**Verified:** 2026-05-11T14:00:00Z
**Status:** gaps_found
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

#### 04-01 Must-Have Truths (OBS-01, OBS-02)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Every tools/call emits audit:tool_call with sessionId, clientPrincipal, tool, upstreamHost, outcome, durationMs, and correlationId | FAILED | correlationId missing from emitAuditToolCall log payload (mcp-server.ts:2266-2273). All other fields present. |
| 2 | Anonymous sessions report 'anonymous' in audit log and metrics | VERIFIED | resolveMetricsContext returns clientIdentity: 'anonymous' fallback (line 2214); emitAuditToolCall defaults to 'anonymous' (line 2264) |
| 3 | Stdio path audit log uses sessionId='stdio' (named sentinel, not null) | FAILED | Lines 1031/1054 pass undefined; coalesced to null at line 2267. Test line 5791 asserts null. |
| 4 | Prometheus output includes upstream_host and client_identity label dimensions | VERIFIED | labelNames for all 3 metrics include both labels (lines 121, 128, 136) |
| 5 | client_identity capped at 64 chars; upstream_host capped at 128 chars; defaults to 'anonymous'/'none' | VERIFIED | Constants defined (lines 38-40); resolveContextLabels slices at caps (lines 467, 471) |
| 6 | mcpToolCallsTotal, mcpToolCallDuration, mcpToolCallErrors carry new labels | VERIFIED | All three labelNames updated in constructor (lines 121, 128, 136) |
| 7 | Both HTTP and stdio paths emit audit logs | VERIFIED | emitAuditToolCall called from stdio handler (lines 1030, 1053), HTTP local-tool (lines 1832, 1869), HTTP upstream (lines 2151, 2171), OAuth reject (line 1640), recordUpstreamReject (line 3180) |
| 8 | extractHost normalizes to lowercase hostname only (no port, no path, no credentials); falls back to 'unknown' on invalid URL | FAILED | extractHost uses .host (includes port), returns original string on invalid URL. extractHost('https://HOST:8080/path') returns 'host:8080' not 'host'; extractHost('not-a-url') returns 'not-a-url' not 'unknown'. |

#### 04-02 Must-Have Truths (OBS-03)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 9 | GET /ready returns 200 with { status: 'ready', profiles: N } when at least one profile loaded | VERIFIED | Route at line 1665; logic at 1668-1673; tests pass |
| 10 | GET /ready returns 503 with { status: 'not ready', reason: 'no profiles loaded' } when empty | VERIFIED | statusCode 503 at line 1669; body at line 1673; test passes |
| 11 | GET /ready requires no authentication | VERIFIED | Only mcpRateLimiter applied (line 1665); clientAuthGate in handlePost only; test confirms no 401/403 |
| 12 | GET /health still returns 200 with { status: 'ok', sessions: N } (liveness - no regression) | VERIFIED | /health handler unchanged; test passes |
| 13 | normalizePath treats /ready as known path (no high-cardinality label) | PARTIAL | '/ready' is in allowlist (line 432). BUT dead-else not fixed: unknown paths still return raw path string (line 436) not 'other'. Session IDs create high-cardinality Prometheus labels. |
| 14 | /ready route handler contains a comment noting it is a shallow check (profile count only, not upstream probe) | FAILED | Comments exist (lines 1661-1664) but don't include 'shallow check' language or explicit note about not probing upstream connectivity. |

**Score:** 9/14 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/core/metrics.ts` | Extended MetricsContextLabels, resolveContextLabels, labelNames with upstreamHost | VERIFIED | upstreamHost in interface (line 28), in resolveContextLabels (line 460), labelNames updated (lines 121, 128, 136) |
| `src/transport/http-transport.ts` | getSessionClientPrincipal accessor + /ready route | VERIFIED | getSessionClientPrincipal at line 4295; /ready route at line 1665 |
| `src/mcp/mcp-server.ts` | Audit log emission + enriched metricsContext | PARTIAL | emitAuditToolCall exists and is called at all paths; correlationId and stdio sentinel are wrong |
| `src/core/metrics.ts` | normalizePath updated with /ready AND 'other' fallback | PARTIAL | /ready added; 'other' fallback NOT implemented |
| `src/transport/http-transport.test.ts` | Tests for /ready: 200, 503, unauthenticated, /health regression | VERIFIED | 4 tests in 'Readiness Endpoint' describe block |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| mcp-server.ts handleToolCall | metrics.ts recordToolCall | enriched MetricsContextLabels with upstreamHost | VERIFIED | upstreamHost spread into metricsContext at lines 1624-1627 |
| mcp-server.ts resolveMetricsContext | http-transport.ts getSessionClientPrincipal | clientIdentity in resolveMetricsContext | VERIFIED | getSessionClientPrincipal called at line 2207 |
| metrics.ts mcpToolCallsTotal | Prometheus registry | labelNames includes upstream_host + client_identity | VERIFIED | Lines 121, 128, 136 |
| GET /ready | profileStates.size > 0 | Express route handler | VERIFIED | profilesLoaded = this.profileStates.size at line 1667 |
| /ready route | mcpRateLimiter | same rate limiter as /health | VERIFIED | mcpRateLimiter applied at line 1665 |
| metrics.ts normalizePath | Prometheus path label | /ready in allowlist | PARTIAL | /ready in allowlist; unknown paths NOT capped to 'other' |

### Data-Flow Trace (Level 4)

Not applicable - this phase adds observability infrastructure (metrics labels, audit log, endpoints), not data rendering components.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| extractHost no-port normalization | `node -e "const f=(u)=>{try{return new URL(u).host}catch{return u}};console.log(f('https://HOST:8080/path'))"` | `host:8080` (expected: `host`) | FAIL |
| extractHost invalid URL fallback | `node -e "const f=(u)=>{try{return new URL(u).host}catch{return u}};console.log(f('not-a-url'))"` | `not-a-url` (expected: `unknown`) | FAIL |
| normalizePath unknown path | (code trace) | Returns raw path, not 'other' | FAIL |
| All tests pass | `npm test -- --reporter=dot` | 3588/3588 passed | PASS |
| TypeScript typecheck | `npm run typecheck` | 0 errors | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| OBS-01 | 04-01-PLAN.md | Structured audit log per tool call | PARTIAL | Audit log emitted at all paths but missing correlationId and uses null not 'stdio' for sessionId |
| OBS-02 | 04-01-PLAN.md | Per-upstream and per-client-identity Prometheus labels | VERIFIED | Labels in all 3 metrics; defaults correct; caps applied |
| OBS-03 | 04-02-PLAN.md | GET /ready readiness probe | PARTIAL | /ready endpoint works; normalizePath 'other' fallback missing; shallow-check comment missing |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/mcp/mcp-server.ts` | 108 | `new URL(url).host` (includes port) instead of `.hostname` | Warning | upstreamHost label includes port number for non-standard ports, reducing label consistency |
| `src/mcp/mcp-server.ts` | 110 | `return url` (original string) instead of `'unknown'` | Warning | Invalid URLs appear verbatim as Prometheus label values and in audit logs, potentially exposing raw input |
| `src/mcp/mcp-server.ts` | 1029-1031 | `sessionId: undefined` (becomes `null`) for stdio path | Warning | Audit consumers cannot distinguish stdio from anonymous HTTP sessions by sessionId field |
| `src/core/metrics.ts` | 436 | `return pathWithoutQuery` dead-else (high-cardinality) | Blocker | Session IDs and arbitrary URL paths become distinct Prometheus label values, causing cardinality explosion in production |
| `src/mcp/mcp-server.test.ts` | 5732, 5736 | Tests assert wrong extractHost behavior (port included, original on error) | Warning | Tests validate current buggy behavior, preventing regression detection |

### Human Verification Required

None - all items can be verified programmatically.

### Gaps Summary

**5 gaps found blocking or partially blocking phase goal achievement:**

**Critical cardinality gap (OBS-03):** The `normalizePath` dead-else was not fixed. Any path not in the allowlist (e.g., `/session-abc123`, `/unknown/resource`) still returns the raw path as a Prometheus label. In production with multiple sessions, this creates an unbounded set of distinct label values, causing Prometheus memory issues (cardinality explosion). The fix is one line: `return 'other'` at line 436, plus updating one test assertion.

**Audit log correlationId gap (OBS-01):** The plan's must-have explicitly listed `correlationId` as a required audit log field. The `emitAuditToolCall` helper does not include it. Security and compliance consumers of the audit trail cannot correlate audit entries with error logs without this field. Error paths do generate a correlationId (line 1062) but it's not passed to the audit helper.

**Stdio sentinel gap (OBS-01):** The plan required `sessionId='stdio'` as a named constant to distinguish stdio transport audit entries from anonymous HTTP sessions (which would also produce `null`). Both would be indistinguishable in the audit log. The implementation uses `undefined`/`null` explicitly (comment at line 1029 says "sessionId=null").

**extractHost port normalization gap (OBS-01):** `extractHost` uses `.host` (includes port, e.g., `api.example.com:8443`) instead of `.hostname` (no port). This creates additional Prometheus label cardinality when non-standard ports are used - the same upstream host at different ports creates different `upstream_host` label values. The plan explicitly required `.hostname` only.

**extractHost invalid-URL fallback gap (OBS-01):** `extractHost` returns the original input string on parse failure instead of `'unknown'`. This means untrusted strings (e.g., a misconfigured transport URL) flow directly into Prometheus labels and audit logs verbatim.

---
_Verified: 2026-05-11T14:00:00Z_
_Verifier: Claude (gsd-verifier)_
