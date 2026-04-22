---
phase: 2
slug: tool-discovery-and-call-proxy
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-30
audited: 2026-04-22
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 02-W0-01 | W0 | 0 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -x` | ✅ | ✅ green |
| 02-W0-02 | W0 | 0 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -x` | ✅ | ✅ green |
| 02-W0-03 | W0 | 0 | PROXY-03, PROXY-04 | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream" -x` | ✅ | ✅ green |
| 02-W0-04 | W0 | 0 | D-02 | unit | `npx vitest run src/profile/profile-loader.test.ts -t "mutual exclusiv" -x` | ✅ | ✅ green |
| 02-PROXY03-01 | proxy | 1 | PROXY-03 | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream tools/list" -x` | ✅ | ✅ green |
| 02-PROXY03-02 | proxy | 1 | PROXY-03 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -x` | ✅ | ✅ green |
| 02-PROXY04-01 | proxy | 1 | PROXY-04 | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream tools/call" -x` | ✅ | ✅ green |
| 02-PROXY04-02 | proxy | 1 | PROXY-04 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "error mapping" -x` | ✅ | ✅ green |
| 02-SEC01-01 | sanitizer | 2 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "name" -x` | ✅ | ✅ green |
| 02-SEC01-02 | sanitizer | 2 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "description" -x` | ✅ | ✅ green |
| 02-SEC01-03 | sanitizer | 2 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "drop" -x` | ✅ | ✅ green |
| 02-REL04-01 | notifications | 3 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "forward" -x` | ✅ | ✅ green |
| 02-REL04-02 | notifications | 3 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "queue" -x` | ✅ | ✅ green |
| 02-REL04-03 | notifications | 3 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "evict" -x` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Coverage Beyond Plan (added by recheck fixes)

| Area | File | Tests Added | Requirement |
|------|------|-------------|-------------|
| Sanitization bypass via tools/call | `mcp-server.test.ts` | 9 (cache enforcement, invalidation, cold-cache) | SEC-01 |
| Policy enforcement pre-dispatch | `mcp-server.test.ts` | 10 (filter, enterprise, invalid name, length) | SEC-01, PROXY-04 |
| Metrics for upstream calls | `mcp-server.test.ts` | 8 (success, error types, filter/policy/sanitization rejections) | PROXY-04 |
| Provider tool allow/deny lists | `mcp-server.test.ts` + `upstream-tool-sanitizer.test.ts` | 15+ (exact, wildcard, combined) | SEC-01 |
| Token precedence (client vs env) | `mcp-server.test.ts` | 4 | PROXY-03, PROXY-04 |

---

## Wave 0 Requirements

- [x] `src/upstream/upstream-tool-sanitizer.ts` + `src/upstream/upstream-tool-sanitizer.test.ts` — 70 tests
- [x] `src/upstream/upstream-notification-queue.ts` + `src/upstream/upstream-notification-queue.test.ts` — 17 tests
- [x] `src/mcp/mcp-server.test.ts` extended with upstream handler coverage — 70+ upstream tests
- [x] `src/profile/profile-loader.test.ts` extended with mutual-exclusivity tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SSE reconnect receives replayed notifications | REL-04 | Requires live SSE disconnect/reconnect cycle | Start gateway, subscribe SSE, disconnect, trigger upstream notification, reconnect, verify notification arrives |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** 2026-04-22 — retroactive audit, all tests green (421 passed across 4 test files)
