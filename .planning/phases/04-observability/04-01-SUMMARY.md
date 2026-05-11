---
phase: 04-observability
plan: 01
subsystem: observability
tags: [prometheus, audit-log, metrics, prom-client, observability, mcp]

# Dependency graph
requires:
  - phase: 03-client-authentication-gate
    provides: SessionData.clientPrincipal (AuthorizedPrincipal on session for identity resolution)
  - phase: 02-tool-discovery-and-call-proxy
    provides: handleUpstreamToolCall, recordUpstreamReject early-reject pipeline
provides:
  - Per-tool-call structured audit log (audit:tool_call at INFO) with stable shape
  - Prometheus tool-call counters/histogram extended with upstream_host + client_identity dimensions
  - HttpTransport.getSessionClientPrincipal accessor for observability lookups
  - Reusable extractHost(url) helper for safe URL-to-host extraction
  - Reusable emitAuditToolCall private helper (single audit-shape source of truth)
affects: [05-observability-completion, future-policy-engine, future-otel-tracing]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Single emitAuditToolCall helper keeps audit-log shape uniform across HTTP success, HTTP error, OAuth-required reject, upstream early-rejects, upstream proxy success/error, and stdio success/error - one grep target, one contract."
    - "Defensive observability: safeBaseUrlHost() wraps getBaseUrl() so missing parser in test doubles never throws through tool-call hot path; falls back to 'none' label semantics consistent with the rest of the pipeline."
    - "Audit log + metric label dimensions held in lockstep: recordUpstreamReject emits both atomically so dashboards never disagree with the audit trail on reject outcomes."

key-files:
  created: []
  modified:
    - src/core/metrics.ts
    - src/core/metrics.test.ts
    - src/transport/http-transport.ts
    - src/transport/http-transport.test.ts
    - src/mcp/mcp-server.ts
    - src/mcp/mcp-server.test.ts
    - CHANGELOG.md

key-decisions:
  - "client_identity capped at 64 chars, upstream_host at 128 chars - bounds Prometheus label cardinality without truncating typical identities/hostnames."
  - "resolveMetricsContext always populates clientIdentity with 'anonymous' fallback (never undefined at the label boundary). Existing tests that strict-equality-asserted the 2-key metricsContext were updated to include clientIdentity: 'anonymous'."
  - "extractHost wraps new URL().host in try/catch and returns the input unchanged on parse failure - audit logs and metric labels never crash on malformed input."
  - "safeBaseUrlHost private wrapper protects observability paths from partial-parser test doubles by returning 'none' instead of throwing - keeps the tool-call hot path resilient."
  - "recordUpstreamReject extended to emit both metrics and audit log in one place. Forces dimensions to match between counter and audit log on every early-reject outcome (FilterRejection, PolicyRejection x2, InvalidToolName, SanitizationRejection)."
  - "Local-tool path re-derives upstreamHost from tenant context (tenantBaseUrl) when present so tenant-routed calls label the actual target, not the global profile default captured at handleToolCall entry."
  - "recordSessionCreated/Destroyed now pass an explicit {profile_id, tenant_id} subset to inc/dec - the wider resolveContextLabels return shape would have triggered prom-client label-validation rejects on session counters that are not registered with the new dimensions."

patterns-established:
  - "OBS-emission helper pattern: a single private method (emitAuditToolCall) owns the audit field shape; every call site passes data, never structures the log object directly. Adding a future field (e.g. tenantId) becomes a single-site change."
  - "Two-key vs four-key resolveContextLabels: metrics that only carry profile/tenant pass an explicit subset to inc/dec; tool-call metrics consume the full shape. Schema drift between counter registration and inc() calls is now an explicit code choice rather than an implicit type widening."

requirements-completed: [OBS-01, OBS-02]

# Metrics
duration: 24min
completed: 2026-05-11
---

# Phase 04 Plan 01: Per-Tool-Call Audit Log + Per-Upstream/Per-Identity Metrics Summary

**Structured `audit:tool_call` INFO log with stable shape (sessionId, clientPrincipal, tool, upstreamHost, outcome, durationMs) at every tool-call outcome plus `upstream_host` and `client_identity` Prometheus label dimensions on mcp_tool_calls_total / mcp_tool_call_duration_seconds / mcp_tool_call_errors_total, covering HTTP success+error, OAuth-required reject, all upstream early-rejects, upstream proxy success+error, and stdio success+error.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-05-11T13:21:19Z
- **Completed:** 2026-05-11T13:45:21Z
- **Tasks:** 2 (both TDD, RED-GREEN cycles)
- **Files modified:** 7 (3 source + 3 tests + CHANGELOG)
- **Commits:** 5 task commits + 1 docs commit

## Accomplishments

- `MetricsContextLabels` extended with optional `upstreamHost` and `clientIdentity` fields; `resolveContextLabels` returns 4 keys with explicit per-label caps (upstream_host 128 chars, client_identity 64 chars).
- All three tool-call Prometheus metrics (`mcp_tool_calls_total`, `mcp_tool_call_duration_seconds`, `mcp_tool_call_errors_total`) registered with the new label dimensions; backward-compatible defaults ('none' / 'anonymous') keep existing dashboards intact while enabling new per-upstream / per-identity slicing.
- `HttpTransport.getSessionClientPrincipal(profileId, sessionId)` accessor exposes the inbound `AuthorizedPrincipal` for observability; returns `undefined` for anonymous sessions which the resolver maps to `'anonymous'` at the label boundary.
- `resolveMetricsContext` in `mcp-server.ts` always populates `clientIdentity` (never `undefined`) so audit logs and metrics share a single shape contract.
- Module-level `extractHost(url)` helper exported for tests; reusable across audit log and metric labels.
- New `emitAuditToolCall` private helper centralizes the audit-log object shape and is invoked at: stdio success, stdio error, HTTP local-tool success, HTTP local-tool error, OAuth-required early-reject, all five upstream early-reject sites (via `recordUpstreamReject`), upstream proxy success, upstream proxy error - one grep target for the entire audit pipeline.
- Per-path upstream host resolution: HTTP `handleToolCall` entry derives from `upstream_mcp.transport.url` or profile base URL; local-tool path overrides with `tenantBaseUrl` when present so tenant-routed calls label the real target.

## Task Commits

Each task was committed atomically following the TDD red-green pattern:

1. **Task 1 RED: failing tests for new metric labels** - `a7dee6c` (test)
2. **Task 1 GREEN: implement upstream_host + client_identity labels** - `e13fe88` (feat) - includes Rule 1 fix on session counters
3. **Task 2 RED: failing tests for getSessionClientPrincipal + audit log + extractHost** - `05f26ed` (test)
4. **Task 2 GREEN: implement accessor, extractHost, audit log emission** - `b40a006` (feat) - includes Rule 1 fixes for safeBaseUrlHost + strict-equality test updates
5. **Docs: CHANGELOG entry for OBS-01 + OBS-02** - `48f6838` (docs)

_Plan metadata commit follows after STATE/ROADMAP/REQUIREMENTS update._

## Files Created/Modified

- `src/core/metrics.ts` - extended `MetricsContextLabels`, `resolveContextLabels`, three tool-call metric `labelNames`; session counter inc/dec now pass explicit 2-key subset to avoid prom-client rejecting the wider label shape on counters not registered with the new dimensions.
- `src/core/metrics.test.ts` - 5 new tests covering the new label dimensions, defaults, truncation (64 / 128 chars), and `recordToolCallError` parity; updated 1 existing strict-equality assertion for the new full label set on `tool_calls_total`.
- `src/transport/http-transport.ts` - new `getSessionClientPrincipal(profileId, sessionId)` accessor that returns the `AuthorizedPrincipal` resolved by the inbound auth gate or `undefined` for anonymous sessions.
- `src/transport/http-transport.test.ts` - 3 new unit tests on the accessor (returns principal, returns undefined for anonymous, returns undefined for unknown profile/session).
- `src/mcp/mcp-server.ts` - module-level `extractHost(url)` helper (exported); private `safeBaseUrlHost()` defensive wrapper; private `emitAuditToolCall()` centralizes audit-log shape; `resolveMetricsContext` populates `clientIdentity` with anonymous fallback; `handleToolCall` enriches `metricsContext` with `upstreamHost` at entry and per-path overrides for local-tool and upstream proxy; `handleUpstreamToolCall` derives audit fields independently of `metricsBundle` so audit always emits even without a metrics collector; `recordUpstreamReject` extended with `sessionId` parameter and emits audit log in addition to metrics; stdio `CallToolRequestSchema` handler enriches `metricsContext` and emits audit log at success/error.
- `src/mcp/mcp-server.test.ts` - new `Audit log (OBS-01)` describe block under `upstream proxy` (6 tests: success, error, anonymous fallback, resolved principal, early-reject audit, host-only assertion), new top-level `extractHost (OBS-01)` block (3 tests), new `stdio audit log (OBS-01)` block (2 tests); 2 existing tests updated to include `clientIdentity: 'anonymous'` in the strict-equality metricsContext assertion.
- `CHANGELOG.md` - one-line user-perspective "Added" entry summarizing both OBS-01 (audit log) and OBS-02 (metric labels) per the AGENTS.md compress-lines rule.

## Decisions Made

- **clientIdentity always populated with 'anonymous' fallback** at `resolveMetricsContext` (not undefined) so every metric / audit log emission has a well-defined identity label, eliminating a class of label-shape drift at runtime.
- **Single `emitAuditToolCall` helper** ensures all 9 audit emission sites (stdio x2, local-tool x2, OAuth reject, upstream early-rejects via `recordUpstreamReject`, upstream proxy x2) produce identical field shapes; future additions (e.g. `tenantId`) become one-site changes.
- **Audit + metric dimensions held in lockstep** by collapsing the dual responsibility into `recordUpstreamReject(sessionId)` for early-rejects - the audit log and the Prometheus counter cannot disagree on `upstream_host` / `client_identity` after a rejection.
- **`safeBaseUrlHost()` private wrapper** prevents observability code from throwing when `parser` is stubbed in unit tests; falls back to 'none' label semantics consistent with the wider pipeline.
- **Local-tool path re-derives `upstreamHost` from `tenantBaseUrl`** so tenant-routed calls label the actual upstream target rather than the global profile default captured at `handleToolCall` entry.
- **Label caps placed at the metric layer** (`UPSTREAM_HOST_LABEL_MAX=128`, `CLIENT_IDENTITY_LABEL_MAX=64`) rather than at every call site - keeps cardinality protection close to the data structure that bounds it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Session counter prom-client label rejection**
- **Found during:** Task 1 GREEN, after extending `resolveContextLabels` return type
- **Issue:** `recordSessionCreated` / `recordSessionDestroyed` pass the full resolved labels object straight to `inc(labels)` / `dec(labels)`. Session counters are registered with only `['profile_id', 'tenant_id']`; the new `upstream_host` and `client_identity` keys would trigger prom-client `validateLabel` rejects, breaking session metrics.
- **Fix:** Build an explicit `{ profile_id, tenant_id }` subset in the two session methods before calling inc/dec. Tool-call metrics intentionally consume the full shape; session metrics intentionally consume the narrow shape. The boundary is now an explicit code choice rather than an implicit type-widening side effect.
- **Files modified:** src/core/metrics.ts
- **Verification:** All 33 metrics tests pass (including the existing 4 session metric tests that started failing during RED).
- **Committed in:** `e13fe88`

**2. [Rule 1 - Bug] `getBaseUrl()` may throw in observability hot path**
- **Found during:** Task 2 GREEN, after wiring `extractHost(this.getBaseUrl())` into `handleToolCall` entry
- **Issue:** `getBaseUrl()` delegates to `this.parser.getBaseUrl()` when no profile interceptor base URL is set. Unit tests that stub `parser` with a partial mock (no `getBaseUrl` method) caused the new observability path to throw `TypeError`, propagating through `handleToolCall` and breaking 2 unrelated tests (`session tool filtering`, `filtering enforcement in tool calls`).
- **Fix:** Added private `safeBaseUrlHost()` wrapper that catches any throw, returns `'none'` label fallback. Replaced all 4 `extractHost(this.getBaseUrl())` callsites in `handleToolCall` + stdio handler with `this.safeBaseUrlHost()`. Tenant-base-URL callsites use `extractHost` directly (no fallback needed; the tenantBaseUrl shape is always a valid string when present).
- **Files modified:** src/mcp/mcp-server.ts
- **Verification:** Both previously-failing tests pass; observability degrades to `'none'` label on partial-parser stubs without breaking the tool-call path.
- **Committed in:** `b40a006`

**3. [Rule 1 - Bug] Two existing strict-equality tests on metricsContext shape**
- **Found during:** Task 2 GREEN, after `resolveMetricsContext` started always populating `clientIdentity: 'anonymous'`
- **Issue:** Two existing tests (`uses tenant base URL...`, `falls back to profile base URL...`) asserted `metricsContext: { profileId, tenantId }` as a strict-equality 2-key object passed to `getOrCreateSessionClient`. The new `clientIdentity` field broke deep equality.
- **Fix:** Updated both tests to expect `{ profileId, tenantId, clientIdentity: 'anonymous' }`. This is correct behavior - anonymous sessions report 'anonymous', not undefined, at the label boundary.
- **Files modified:** src/mcp/mcp-server.test.ts
- **Verification:** Both tests pass; the strict-equality contract now reflects the always-populated shape.
- **Committed in:** `b40a006`

---

**Total deviations:** 3 auto-fixed (all Rule 1 - Bug).
**Impact on plan:** All three were tight-coupling artifacts surfaced by the new label shape. No scope creep; no architectural changes; each fix is local and reversible. The plan as written assumed `resolveContextLabels` could safely widen its return shape - the session-counter regression and the `getBaseUrl()` throw were both invisible until tests ran, so the deviations primarily protect downstream consumers against the new shape.

## Issues Encountered

None - all task verification ran clean after the deviations above were applied. The full 3582-test suite plus `tsc --noEmit` are green at every commit boundary on this plan after the GREEN phase of each task.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- OBS-01 and OBS-02 are fully complete and committed.
- `audit:tool_call` is now emitted on real test runs (visible in vitest stderr) - downstream log shippers can start consuming the structured field shape immediately.
- New `client_identity` / `upstream_host` Prometheus labels are live; dashboards can be added now or after OBS-03 (Phase 04 Plan 02).
- Ready for `04-02-PLAN.md` execution (OBS-03 - whatever the next plan covers); no blockers carried forward.

---
*Phase: 04-observability*
*Completed: 2026-05-11*

## Self-Check: PASSED

- All key-files (created/modified) confirmed present on disk via `[ -f ]`.
- All 5 task commits (a7dee6c, e13fe88, 05f26ed, b40a006, 48f6838) confirmed reachable via `git log --oneline --all`.
- Final `npm run typecheck` exit code 0; final `npm test --run` reports 3582/3582 tests passed across 160 test files.
- Verification greps from PLAN.md success_criteria:
  - `grep 'upstream_host\|client_identity' src/core/metrics.ts` -> 15 matches (label names, defaults, return type).
  - `grep 'getSessionClientPrincipal' src/transport/http-transport.ts` -> 1 match (the accessor itself).
  - `grep 'audit:tool_call' src/mcp/mcp-server.ts` -> 3 matches (helper docstring, single `logger.info` call site inside the helper, one inline comment at recordUpstreamReject).
  - `grep -E 'upstreamHost|upstream_host' src/mcp/mcp-server.ts` -> 25 matches (well above the >= 10 threshold required by the plan).
