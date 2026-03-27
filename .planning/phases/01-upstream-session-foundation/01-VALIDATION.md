---
phase: 1
slug: upstream-session-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-27
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (existing) |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/upstream/` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~30 seconds (quick), ~2 minutes (full) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/upstream/ && npm run typecheck`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds (quick run)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| PROXY-01a | 01 | 1 | PROXY-01 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "lazy"` | ❌ W0 | ⬜ pending |
| PROXY-01b | 01 | 1 | PROXY-01 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "getOrConnect"` | ❌ W0 | ⬜ pending |
| PROXY-01c | 01 | 1 | PROXY-01 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "concurrent"` | ❌ W0 | ⬜ pending |
| PROXY-02a | 01 | 1 | PROXY-02 | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "bearer"` | ❌ W0 | ⬜ pending |
| PROXY-02b | 01 | 1 | PROXY-02 | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "custom-header"` | ❌ W0 | ⬜ pending |
| PROXY-02c | 01 | 1 | PROXY-02 | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "redact"` | ❌ W0 | ⬜ pending |
| SEC-02a | 01 | 2 | SEC-02 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "redact"` | ❌ W0 | ⬜ pending |
| SEC-02b | 01 | 2 | SEC-02 | unit | `npx vitest run src/auth/auth-redaction.test.ts -t "upstream"` | ❌ W0 | ⬜ pending |
| SEC-02c | 01 | 2 | SEC-02 | unit | `npx vitest run src/auth/auth-redaction.test.ts -t "sanitize.*upstream"` | ❌ W0 | ⬜ pending |
| REL-01a | 02 | 2 | REL-01 | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "interval"` | ❌ W0 | ⬜ pending |
| REL-01b | 02 | 2 | REL-01 | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "failure"` | ❌ W0 | ⬜ pending |
| REL-01c | 02 | 2 | REL-01 | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "cleanup"` | ❌ W0 | ⬜ pending |
| REL-02a | 02 | 2 | REL-02 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "reaper"` | ❌ W0 | ⬜ pending |
| REL-02b | 02 | 2 | REL-02 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "unclean"` | ❌ W0 | ⬜ pending |
| REL-02c | 02 | 2 | REL-02 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "closeAll"` | ❌ W0 | ⬜ pending |
| REL-03a | 01 | 2 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "timeout"` | ❌ W0 | ⬜ pending |
| REL-03b | 01 | 2 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "auth"` | ❌ W0 | ⬜ pending |
| REL-03c | 01 | 2 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "unavailable"` | ❌ W0 | ⬜ pending |
| REL-03d | 01 | 2 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "correlation"` | ❌ W0 | ⬜ pending |
| REL-03e | 01 | 2 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "no stack"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/upstream/upstream-connection-manager.test.ts` — stubs for PROXY-01, REL-02
- [ ] `src/upstream/upstream-credential-store.test.ts` — stubs for PROXY-02
- [ ] `src/upstream/upstream-heartbeat.test.ts` — stubs for REL-01
- [ ] `src/upstream/upstream-errors.test.ts` — stubs for REL-03, SEC-02 (error path)
- [ ] `src/auth/auth-redaction.test.ts` — extend existing tests for upstream credential fields (SEC-02)
- [ ] Mock upstream MCP server utility for integration tests

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Credential not visible in structured log output | SEC-02 | Requires live logger output inspection | Run server with upstream profile, trigger tool call with bearer token, grep log output for token value |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
