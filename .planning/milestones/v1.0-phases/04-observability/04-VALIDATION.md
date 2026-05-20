---
phase: 04
slug: observability
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-18
verified_gaps_fixed: 2026-05-18
---

# Phase 04 — Validation Strategy

> Reconstructed from 04-01-SUMMARY.md, 04-02-SUMMARY.md, and 04-VERIFICATION.md.
> All 5 gaps found by the verifier were fixed in subsequent commits; verified 2026-05-18.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npm test -- --run -t "Tool Call Metrics\|Audit log\|extractHost\|Readiness Endpoint\|normalizePath\|stdio audit"` |
| **Full suite command** | `npm test -- --run` |
| **Estimated runtime** | ~25s full, ~12s targeted |

---

## Sampling Rate

- **After every task commit:** Run targeted command above
- **After every plan wave:** Run full suite
- **Before `/gsd:verify-work`:** Full suite must be green (3624/3624)
- **Max feedback latency:** ~25 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test File | Automated Command | Status |
|---------|------|------|-------------|-----------|-------------------|--------|
| 04-01-T1 | 01 | 1 | OBS-02 | `src/core/metrics.test.ts` | `npm test -- --run -t "Tool Call Metrics"` | ✅ green |
| 04-01-T2 | 01 | 1 | OBS-01 | `src/mcp/mcp-server.test.ts` | `npm test -- --run -t "Audit log \(OBS-01\)\|extractHost\|stdio audit log"` | ✅ green |
| 04-02-T1 | 02 | 1 | OBS-03 | `src/transport/http-transport.test.ts`, `src/core/metrics.test.ts` | `npm test -- --run -t "Readiness Endpoint\|normalizePath"` | ✅ green |

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements.*

---

## Requirement Coverage Detail

### OBS-01: Structured audit log per tool call

| Behavior | Test | Status |
|----------|------|--------|
| `audit:tool_call` emitted on upstream success | `Audit log (OBS-01) > emits audit:tool_call … on upstream success` | ✅ |
| `audit:tool_call` emitted on upstream error | `Audit log (OBS-01) > emits audit:tool_call with outcome=error…` | ✅ |
| `audit:tool_call` on FilterRejection early-reject | `Audit log (OBS-01) > emits audit:tool_call on upstream early-reject (FilterRejection)` | ✅ |
| correlationId present on FilterRejection | `Audit log (OBS-01) > audit:tool_call on FilterRejection has a defined correlationId` | ✅ |
| upstreamHost is host-only (no path/scheme) | `Audit log (OBS-01) > upstreamHost in audit log is host-only` | ✅ |
| PolicyRejection, InvalidToolName, SanitizationRejection, OAuthRequired emitted | 4 separate tests | ✅ |
| Local HTTP tool success + error | `emits audit:tool_call on local HTTP tool success/failure` | ✅ |
| sessionId='unknown' fallback when undefined | `uses sessionId="unknown" in audit log when sessionId is undefined` | ✅ |
| audit fires without metrics collector | `skips metric recording when no collector … but still emits audit log` | ✅ |
| Stdio path: sessionId='stdio', clientPrincipal='anonymous' | `stdio audit log (OBS-01) > emits audit:tool_call with sessionId=stdio…` | ✅ |
| Stdio path error outcome | `stdio audit log (OBS-01) > emits audit:tool_call with outcome=error on stdio path` | ✅ |
| extractHost: strips port (hostname only) | `extractHost (OBS-01) > strips port` | ✅ |
| extractHost: returns 'unknown' on invalid URL | `extractHost (OBS-01) > returns "unknown" for non-URL string` | ✅ |
| extractHost: returns 'unknown' for empty string | `extractHost (OBS-01) > returns "unknown" for bare protocol` | ✅ |

### OBS-02: Per-upstream Prometheus labels

| Behavior | Test | Status |
|----------|------|--------|
| `upstream_host` label on mcp_tool_calls_total | `Tool Call Metrics > records upstream_host label when provided (OBS-02)` | ✅ |
| `upstream_host` defaults to 'none' when omitted | `Tool Call Metrics > defaults upstream_host to "none" when omitted (OBS-02)` | ✅ |
| `upstream_host` truncated at 128 chars | `Tool Call Metrics > truncates upstream_host to 128 chars (OBS-02)` | ✅ |
| `upstream_host` on recordToolCallError | `Tool Call Metrics > records upstream_host for recordToolCallError (OBS-02)` | ✅ |
| `client_identity` NOT in Prometheus output (audit-log only) | asserted via `not.toContain('client_identity=')` in above tests | ✅ |
| Session metrics do NOT carry upstream_host | `does not include upstream_host label in session metrics` | ✅ |
| Tool name truncated at 64 chars in labels | `truncates tool name to 64 chars in Prometheus labels (OBS-02)` | ✅ |

### OBS-03: GET /ready readiness probe

| Behavior | Test | Status |
|----------|------|--------|
| 200 + `{ status: 'ready', profiles: N }` when loaded | `Readiness Endpoint > returns 200 with ready status` | ✅ |
| 503 + `{ status: 'not ready', reason: ... }` when empty | `Readiness Endpoint > returns 503 when no profiles are loaded` | ✅ |
| Unauthenticated (no 401/403) | `Readiness Endpoint > is unauthenticated` | ✅ |
| Profile count accurate | `Readiness Endpoint > returns accurate profile count` | ✅ |
| Metrics emitted for GET /ready | `Readiness Endpoint Metric Emission > records HTTP metric for GET /ready` | ✅ |
| /health unchanged (regression) | `Health Endpoint > should return health status` | ✅ |
| normalizePath('/ready') → '/ready' | `should normalize /ready path` | ✅ |
| normalizePath('/ready?q') → '/ready' (query stripped) | `should normalize /ready path with query string` | ✅ |
| normalizePath('/ready/') → 'other' (dead-else fixed) | `should normalize /ready/ (trailing slash) to other` | ✅ |
| normalizePath(unknown) → 'other' (cardinality cap) | `should return 'other' for unknown paths` | ✅ |

---

## Verification Gap Fixes (2026-05-18)

The verifier (run 2026-05-11) found 5 gaps. All fixed in subsequent commits:

| Gap | Fix Commit | Verified |
|-----|-----------|---------|
| `extractHost` used `.host` (included port) | `41a8254` | ✅ `.hostname` now used |
| `extractHost` returned original string on error | `41a8254` | ✅ returns `'unknown'` |
| Stdio sessionId was `null`, not `'stdio'` | `41a8254` | ✅ `STDIO_SESSION_ID = 'stdio' as const` |
| `correlationId` missing from audit log payload | `41a8254` | ✅ threaded through all call sites |
| `normalizePath` dead-else didn't return `'other'` | `8eecfd7` | ✅ `return 'other'` at line 439 |
| `/ready` comment lacked "shallow check" language | `044e0f4`+ | ✅ line 1662 in http-transport.ts |

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify commands
- [x] Sampling continuity: every task has at least one automated test command
- [x] No Wave 0 gaps — existing infrastructure covers all requirements
- [x] No watch-mode flags
- [x] Feedback latency: ~12s targeted, ~25s full
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-05-18
