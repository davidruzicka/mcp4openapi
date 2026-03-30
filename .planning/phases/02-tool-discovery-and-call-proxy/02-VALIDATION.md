---
phase: 2
slug: tool-discovery-and-call-proxy
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-30
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
| 02-W0-01 | W0 | 0 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -x` | ❌ W0 | ⬜ pending |
| 02-W0-02 | W0 | 0 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -x` | ❌ W0 | ⬜ pending |
| 02-W0-03 | W0 | 0 | PROXY-03, PROXY-04 | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream" -x` | ❌ W0 | ⬜ pending |
| 02-W0-04 | W0 | 0 | D-02 | unit | `npx vitest run src/profile/profile-loader.test.ts -t "mutual exclusiv" -x` | ❌ W0 | ⬜ pending |
| 02-PROXY03-01 | proxy | 1 | PROXY-03 | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream tools/list" -x` | ❌ W0 | ⬜ pending |
| 02-PROXY03-02 | proxy | 1 | PROXY-03 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -x` | ❌ W0 | ⬜ pending |
| 02-PROXY04-01 | proxy | 1 | PROXY-04 | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream tools/call" -x` | ❌ W0 | ⬜ pending |
| 02-PROXY04-02 | proxy | 1 | PROXY-04 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "error mapping" -x` | ❌ W0 | ⬜ pending |
| 02-SEC01-01 | sanitizer | 2 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "name" -x` | ❌ W0 | ⬜ pending |
| 02-SEC01-02 | sanitizer | 2 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "description" -x` | ❌ W0 | ⬜ pending |
| 02-SEC01-03 | sanitizer | 2 | SEC-01 | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "drop" -x` | ❌ W0 | ⬜ pending |
| 02-REL04-01 | notifications | 3 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "forward" -x` | ❌ W0 | ⬜ pending |
| 02-REL04-02 | notifications | 3 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "queue" -x` | ❌ W0 | ⬜ pending |
| 02-REL04-03 | notifications | 3 | REL-04 | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "evict" -x` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/upstream/upstream-tool-sanitizer.ts` + `src/upstream/upstream-tool-sanitizer.test.ts` - stubs for SEC-01
- [ ] `src/upstream/upstream-notification-queue.ts` + `src/upstream/upstream-notification-queue.test.ts` - stubs for REL-04
- [ ] `src/mcp/mcp-server.test.ts` extended with upstream handler stubs - covers PROXY-03, PROXY-04
- [ ] `src/profile/profile-loader.test.ts` extended with mutual-exclusivity stubs - covers D-02

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SSE reconnect receives replayed notifications | REL-04 | Requires live SSE disconnect/reconnect cycle | Start gateway, subscribe SSE, disconnect, trigger upstream notification, reconnect, verify notification arrives |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
