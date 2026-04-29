---
phase: 03-client-authentication-gate
validated: 2026-04-29
status: gaps-filled
source: reconstructed-from-summaries
---

# Phase 03 — Nyquist Validation Report

**Phase Goal:** M2M clients authenticated via API keys before any upstream resource consumed; resolved identity attached to session.

---

## Coverage Audit

### Existing test files

| File | Tests | Behaviors covered |
|------|-------|-------------------|
| `src/profile/client-auth-gate-validator.test.ts` | 19 | Validator: all valid/invalid configs, mode resolution, mutual exclusion, fail-fast env checks |
| `src/auth/api-key-store.test.ts` | 13 | InlineApiKeyStore: match/miss/empty-env/length/multi-entry/scopes/authType/timing-safe; factory dispatch + unsupported type |
| `src/auth/client-auth-gate.test.ts` | 12 | Gate orchestrator: all mode × token combinations, mode_from_env, Phase 4 deferral guard |
| `src/transport/http-transport-client-auth.test.ts` | 8 | Integration: 8-scenario session-init matrix |

**Total before gap-fill:** 52 tests across 4 files.

---

## Gap Analysis

### Gap 1 — Warn log `errorType: 'ClientAuthGateError'` not verified (medium)

**Observable truth:** When the gate throws `ClientAuthGateError` (Scenarios 2 and 4 — invalid key + required, no token + required), the transport emits `logger.warn('Client auth gate rejected session init', { errorType: 'ClientAuthGateError' })`. Operators use this field to distinguish expected auth rejections from unexpected store failures (`errorType: 'unknown'`).

**Coverage gap:** Scenario 8 verifies `errorType: 'unknown'`. Scenarios 2 and 4 only assert `statusCode: 401`; neither spies on the warn log. The `'ClientAuthGateError'` branch of the discriminator is untested.

**Risk:** Someone could change `isClientAuthGateError ? 'ClientAuthGateError' : 'unknown'` to a constant string and no test would catch it.

**Fix:** Add Scenario 9 to `http-transport-client-auth.test.ts`.

---

### Gap 2 — Session-creation log structured fields not verified (medium)

**Observable truth (VERIFICATION.md #13):** When a valid key resolves a `clientPrincipal`, `logger.info('Session created')` includes `clientSubject: principal.subject` and `clientAuthType: principal.authType` structured fields.

**Coverage gap:** Scenario 1 verifies `session.clientPrincipal` is populated in memory. No test spies on the logger to assert these fields appear in the log call. Evidence in VERIFICATION.md was source-inspection only (`http-transport.ts L3529-3530`).

**Risk:** The log fields could be silently dropped or renamed without a test failure. Phase 5 audit logging reads these fields.

**Fix:** Add Scenario 10 to `http-transport-client-auth.test.ts`.

---

### Gap 3 — Whitespace-only env var value not tested (low)

**Observable truth:** `InlineApiKeyStore.validate()` skips entries whose `process.env[key_from_env]` value is whitespace-only (`!configured?.trim()`), treating them the same as unset. This prevents validating an inbound key against an accidental whitespace slot.

**Coverage gap:** The empty-string case is tested (`EMPTY_API_KEY_ENV_VAR: ''`). The whitespace-only case (`'   '`) is not.

**Risk:** If the `?.trim()` is removed, empty-string test still catches it (because `!''` is true). But if someone changes the condition to `!configured` (no trim), whitespace-only env vars would silently validate inbound keys — a security regression.

**Fix:** Add one test to `src/auth/api-key-store.test.ts`.

---

## Gaps Not Generated (acceptable omissions)

| Behavior | Reason omitted |
|----------|---------------|
| Gate reuse across requests (per-profile lifecycle) | Implicitly verified: Scenario 8 digs into `profileStates` and monkey-patches the gate — proves it persists. No isolated test needed. |
| `Bearer ` prefix stripping | Implicit in Scenario 1: sends `Bearer ${VALID_KEY}`, gate receives bare key, match succeeds. The extraction path is covered by `extractAuthToken` tests elsewhere. |
| Multiple profiles with different gate configs | Out of scope for Phase 3 Nyquist; single-profile behavior is the unit of work. Multi-profile isolation is structural, not a Phase 3 deliverable. |
| `buildDefaultProfileContext()` gate propagation | One-line passthrough (`this.config.client_auth_gate`). Line covered by integration tests that call `makeTransport()` without a gate (Scenario 7). Adding a test for the prop-copy adds noise without catching real regressions. |

---

## Tests Generated

- **`src/transport/http-transport-client-auth.test.ts`** — added Scenarios 9 and 10
- **`src/auth/api-key-store.test.ts`** — added whitespace-only env var test

---

## Final State

| File | Tests before | Tests after | Gaps closed |
|------|-------------|-------------|-------------|
| `src/transport/http-transport-client-auth.test.ts` | 8 | 10 | Gap 1, Gap 2 |
| `src/auth/api-key-store.test.ts` | 13 | 14 | Gap 3 |

**Total after gap-fill:** 55 tests. All 3 gaps closed.
