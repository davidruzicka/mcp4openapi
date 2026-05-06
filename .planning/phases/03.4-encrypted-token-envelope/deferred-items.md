# Deferred Items - Phase 03.4-encrypted-token-envelope

## Pre-existing test failures (out of scope for this phase)

The following 3 tests in `src/testing/token-validation.test.ts` were already failing
on `main` (commit 315e716) BEFORE Phase 03.4 work began. They are unrelated to the
encrypted-token-envelope feature and remain failing after the phase's changes.

Verified: checking out main's pre-phase http-transport.ts and http-transport.test.ts
reproduces all 3 failures, confirming they are pre-existing.

| Test | Failure |
|------|---------|
| `Token Validation Integration > Invalid Token > should reject invalid token after failed validation` | expected 401, got 200 |
| `Token Validation Integration > Invalid Token > should reject expired token` | expected 401, got 200 |
| `Token Validation Integration > Validation Endpoint Errors > should handle validation endpoint timeout` | expected 401, got 200 |

These should be triaged in a separate, focused plan once the cause is identified.
Keeping them deferred preserves scope boundary discipline (Phase 03.4 must not
auto-fix unrelated pre-existing failures).
