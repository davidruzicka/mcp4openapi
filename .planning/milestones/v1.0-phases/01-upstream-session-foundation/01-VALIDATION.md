---
phase: 1
slug: upstream-session-foundation
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-27
---

# Phase 1 - Validation Strategy

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

## Wave 0 Strategy

Wave 0 is satisfied by the **TDD-in-task approach**: every implementation task in all three plans has `tdd="true"` and a `<behavior>` block. Tests are written FIRST within each task before implementation code. This means:

- No separate Wave 0 plan is needed
- Test scaffolds are created as the first step of each task's execution
- The RED phase (failing tests) is the first action in each task
- GREEN phase (implementation) follows immediately
- Each task commit includes both tests and implementation

All test files listed below are created within their respective tasks:

| Test File | Created In | Covers |
|-----------|------------|--------|
| `src/upstream/upstream-errors.test.ts` | Plan 01, Task 1 | REL-03, SEC-02 (error path) |
| `src/upstream/upstream-credential-store.test.ts` | Plan 01, Task 2 | PROXY-02 |
| `src/upstream/upstream-credential-extractor.test.ts` | Plan 01, Task 3 | PROXY-02 (header extraction) |
| `src/auth/auth-redaction.test.ts` (extensions) | Plan 01, Task 2 | SEC-02 (redaction) |
| `src/upstream/upstream-connection-manager.test.ts` | Plan 02, Task 1+2 | PROXY-01, REL-02 |
| `src/upstream/upstream-heartbeat.test.ts` | Plan 03, Task 1 | REL-01 |

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| PROXY-01a | 02 | 2 | PROXY-01 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "lazy"` | TDD-in-task | pending |
| PROXY-01b | 02 | 2 | PROXY-01 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "getOrConnect"` | TDD-in-task | pending |
| PROXY-01c | 02 | 2 | PROXY-01 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "concurrent"` | TDD-in-task | pending |
| PROXY-02a | 01 | 1 | PROXY-02 | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "bearer"` | TDD-in-task | pending |
| PROXY-02b | 01 | 1 | PROXY-02 | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "custom-header"` | TDD-in-task | pending |
| PROXY-02c | 01 | 1 | PROXY-02 | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "redact"` | TDD-in-task | pending |
| PROXY-02d | 01 | 1 | PROXY-02 | unit | `npx vitest run src/upstream/upstream-credential-extractor.test.ts` | TDD-in-task | pending |
| SEC-02a | 01 | 1 | SEC-02 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "redact"` | TDD-in-task | pending |
| SEC-02b | 01 | 1 | SEC-02 | unit | `npx vitest run src/auth/auth-redaction.test.ts -t "upstream"` | TDD-in-task | pending |
| SEC-02c | 01 | 1 | SEC-02 | unit | `npx vitest run src/auth/auth-redaction.test.ts -t "sanitize.*upstream"` | TDD-in-task | pending |
| REL-01a | 03 | 2 | REL-01 | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "interval"` | TDD-in-task | pending |
| REL-01b | 03 | 2 | REL-01 | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "failure"` | TDD-in-task | pending |
| REL-01c | 03 | 2 | REL-01 | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "cleanup"` | TDD-in-task | pending |
| REL-02a | 02 | 2 | REL-02 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "reaper"` | TDD-in-task | pending |
| REL-02b | 02 | 2 | REL-02 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "unclean"` | TDD-in-task | pending |
| REL-02c | 02 | 2 | REL-02 | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "closeAll"` | TDD-in-task | pending |
| REL-02d | 02 | 2 | REL-02 | integration | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "session destroy"` | TDD-in-task | pending |
| REL-03a | 01 | 1 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "timeout"` | TDD-in-task | pending |
| REL-03b | 01 | 1 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "auth"` | TDD-in-task | pending |
| REL-03c | 01 | 1 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "unavailable"` | TDD-in-task | pending |
| REL-03d | 01 | 1 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "correlation"` | TDD-in-task | pending |
| REL-03e | 01 | 1 | REL-03 | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "no stack"` | TDD-in-task | pending |

*Status: pending / green / red / flaky*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Credential not visible in structured log output | SEC-02 | Requires live logger output inspection | Run server with upstream profile, trigger tool call with bearer token, grep log output for token value |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covered by TDD-in-task approach (tests written first within each task)
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter
- [x] `wave_0_complete: true` set in frontmatter

**Approval:** ready
