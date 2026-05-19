---
phase: 04-observability
plan: 02
subsystem: infra
tags: [observability, kubernetes, readiness, liveness, prometheus, express]

# Dependency graph
requires:
  - phase: 03-client-authentication-gate
    provides: clientAuthGate placement inside handlePost (not at route level) - guarantees /ready remains unauthenticated without adding an explicit bypass
provides:
  - GET /ready readiness probe endpoint returning 200 when at least one profile is loaded, 503 otherwise
  - Explicit /ready entry in normalizePath() allowlist to document the gateway's stable surface
  - Test fixture pattern for verifying both ready and not-ready states using createProfileState helper
affects: [04-observability-01, deployment, kubernetes-probes, load-balancer-config]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Readiness vs liveness split - /health stays as liveness (always 200), /ready is readiness (200 only when serving traffic)"
    - "Pass local statusCode (not res.statusCode) to metrics.recordHttpRequest after res.status().json() - deterministic capture regardless of res lifecycle"
    - "Explicit allowlist of stable gateway paths in normalizePath() - documents surface, guards against future dynamic-prefix code paths"

key-files:
  created: []
  modified:
    - src/transport/http-transport.ts
    - src/core/metrics.ts
    - src/transport/http-transport.test.ts
    - src/core/metrics.test.ts

key-decisions:
  - "Readiness condition fixed at profileStates.size > 0 (locked in 04-CONTEXT.md) - simplest accurate signal of can-serve-traffic"
  - "/ready uses mcpRateLimiter only; no explicit auth bypass needed because clientAuthGate lives inside handlePost, not at route level (mirrors /health exactly)"
  - "Pass local statusCode (not res.statusCode) to recordHttpRequest - avoids any ambiguity about res state after res.status().json()"
  - "Explicit '/ready' branch in normalizePath() despite functionally redundant - documents intent and future-proofs against dynamic-prefix paths being introduced"
  - "Default test fixture has empty profileStates - exercised the 503 path naturally; 200 path uses existing createProfileState helper - no new test infrastructure introduced"

patterns-established:
  - "Probe endpoint pattern: GET /probe, mcpRateLimiter middleware, local statusCode variable, branchless res.status().json() with ternary body, metrics emission after response"
  - "TDD RED-GREEN for additive route: write 4 endpoint tests (success / failure / counter accuracy / no-auth) + 2 metrics-path tests, confirm 404, implement, confirm green"

requirements-completed: [OBS-03]

# Metrics
duration: 13min
completed: 2026-05-11
---

# Phase 4 Plan 02: Readiness Probe Endpoint Summary

**GET /ready readiness probe wired alongside existing /health liveness, returning 503 until at least one profile is loaded so Kubernetes readinessProbe and load balancers can gate traffic correctly.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-05-11T13:19:47Z
- **Completed:** 2026-05-11T13:32:37Z
- **Tasks:** 1
- **Files modified:** 4

## Accomplishments

- GET /ready route registered inside setupRoutes immediately after /health, using the same rate-limit/unauth surface
- 200 response carries { status: 'ready', profiles: N } where N = this.profileStates.size when N > 0
- 503 response carries { status: 'not ready', reason: 'no profiles loaded' } when profileStates is empty
- normalizePath() in src/core/metrics.ts extended with explicit '/ready' branch so Prometheus path label stays stable even if future code prepends dynamic segments
- 4 new readiness tests (200 with profile, 503 without, profile count accuracy, no-auth-required) plus 2 metrics normalization tests (with and without query string) - all green
- /health regression test still passes with original { status: 'ok', sessions: N } shape unchanged

## Task Commits

1. **Task 1: Add /ready route and /ready normalization** - `044e0f4` (feat) - combined RED+GREEN into one commit since the additive scope is atomic (4 test cases + 1 route + 1 normalizePath branch)

## Files Created/Modified

- `src/transport/http-transport.ts` - +21 lines: new /ready route handler inside setupRoutes() after /health
- `src/core/metrics.ts` - +3 lines: '/ready' added to normalizePath() known-path allowlist and JSDoc example
- `src/transport/http-transport.test.ts` - +42 lines: new 'Readiness Endpoint' describe block with 4 test cases
- `src/core/metrics.test.ts` - +14 lines: 2 new normalization tests for /ready with and without query string

## Decisions Made

- **Single TDD commit:** RED and GREEN combined into one `feat` commit. Plan defined exactly one task and the new route + tests are trivially small (one Express handler, one if-branch); separating them would have introduced ceremony without traceability benefit. Test code precedes implementation in the diff so a reviewer can still read RED then GREEN linearly.
- **No metrics assertion in route tests:** Default fixture sets `metricsEnabled: false`, so the route's metrics emission is exercised indirectly via the existing metrics.test.ts path-normalization suite rather than duplicating instrumentation assertions in the transport test.
- **Local statusCode variable:** Passed to `recordHttpRequest` instead of reading `res.statusCode` post-`res.status().json()`. The plan explicitly called this out (see plan action notes); preserves deterministic metric capture regardless of res state semantics.
- **Explicit /ready in normalizePath() despite functional no-op:** The pre-existing fallback already returned `pathWithoutQuery`, so `/ready` was already normalized correctly. The explicit branch is intentional - it documents the gateway's stable public surface and guards against the future scenario where the allowlist gains routing or relabeling logic.

## Deviations from Plan

None - plan executed exactly as written. The only deliberate adaptation was the 503 test setup: the plan suggested constructing a fresh empty transport, but the default test fixture already starts with empty profileStates, so the simpler approach (default fixture for 503, `createProfileState` for 200) matched the test file's established pattern as the plan's note explicitly invited.

## Issues Encountered

- **Full test suite produced 3 timeout-style failures in unrelated files** (`src/transport/http-transport-payload.test.ts` "should accept 1MB JSON payloads" at ~305s; `src/mcp/mcp-server.test.ts` "should return empty resources/list when no appsModel" at ~25s and "should return empty resources/templates/list when no appsModel" at ~288s). Re-running each file in isolation produced 100% green (144ms and 697ms respectively). One additional worker-startup error in `src/testing/mock-utils.test.ts` confirms infrastructure flakiness under parallel load. These are pre-existing parallel-suite flakes, not regressions caused by this plan's 19-line route addition + 1-line metrics allowlist branch. Logged here for transparency; no fix applied per SCOPE BOUNDARY (only auto-fix issues directly caused by the current task's changes).

## User Setup Required

None - no external service configuration required. Operators consuming /ready will want to update their Kubernetes deployment manifest:

```yaml
readinessProbe:
  httpGet:
    path: /ready
    port: <http-port>
  initialDelaySeconds: 5
  periodSeconds: 10
livenessProbe:
  httpGet:
    path: /health
    port: <http-port>
```

This is documented in 04-CONTEXT.md success criteria and falls under the user-facing rollout that 04-01 (audit + metrics labels) and a future docs-only plan will land.

## Next Phase Readiness

- OBS-03 (readiness probe) is complete; OBS-01 (audit log) and OBS-02 (per-upstream metrics labels) remain in 04-01.
- /ready is wired but currently emits HTTP metrics only when MetricsCollector is enabled; this matches the existing /health behavior and the 04-CONTEXT.md decision to not add new registries.
- No blockers introduced. The route is additive and ships behind no feature flag.

## Self-Check: PASSED

- File exists: `.planning/phases/04-observability/04-02-SUMMARY.md` (this file)
- Commit `044e0f4` present in `git log`: feat(04-02): add /ready readiness probe endpoint
- Source verification (plan success criteria):
  - `grep "'/ready'" src/transport/http-transport.ts` -> line 1665 (route registration)
  - `grep "ready" src/core/metrics.ts` -> lines 383, 394 (JSDoc + allowlist branch)
- Test verification: `npm test -- -t "Readiness Endpoint"` -> 4 passed; `npm test -- -t "Health Endpoint"` -> 1 passed (regression)
- `npm run typecheck` -> 0 errors

---
*Phase: 04-observability*
*Completed: 2026-05-11*
