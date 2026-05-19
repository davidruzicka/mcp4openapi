---
phase: 03-client-authentication-gate
plan: 02
subsystem: auth
tags: [client-auth-gate, api-keys, inline-store, hmac, timing-safe-equal, factory-pattern, typescript]

# Dependency graph
requires:
  - phase: 03-client-authentication-gate
    provides: ApiKeyStoreConfig, InlineApiKeyEntry, AuthorizedPrincipal interface, ClientAuthGateError
provides:
  - ApiKeyStore interface (validate(key) -> Promise<AuthorizedPrincipal | null>)
  - InlineApiKeyStore implementation with constant-time HMAC-SHA256 comparison
  - createApiKeyStore factory keyed off ApiKeyStoreConfig.type (currently 'inline')
  - 13 unit tests covering valid/wrong/missing/empty key paths, scopes default, authType=token, timing-safe HMAC contract, and factory dispatch + e2e smoke
affects: [03-03, 04-oidc-jwt-gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Constant-time API key comparison via HMAC-SHA256 + timingSafeEqual on equal-length 32-byte digests (length erased as side-channel)"
    - "Direct if-branch factory (not registry table) so Phase 4's union widening triggers a TS exhaustiveness error at the extension site"
    - "Logger parameter retained on factory signature even when unused, to keep Phase 4's signature additive (non-breaking for callers)"

key-files:
  created:
    - src/auth/api-key-store.ts
    - src/auth/inline-api-key-store.ts
    - src/auth/api-key-store-factory.ts
    - src/auth/api-key-store.test.ts
  modified:
    - CHANGELOG.md

key-decisions:
  - "Per-instance random HMAC secret used purely as a length-normalization device (not an authenticator); HMAC-SHA256 always emits 32 bytes so timingSafeEqual is invoked on equal-length buffers regardless of raw key lengths"
  - "HMAC recomputed per call instead of pre-computed at construction: targets small deployments (1-5 keys), avoids env-var-rotation invalidation complexity, and keeps the store stateless beyond the entries array"
  - "Empty string and undefined env-var values both treated as 'not configured' (entry skipped); avoids the surprise of validating an inbound empty key against an empty configured slot"
  - "Direct if-branch on config.type instead of Record<string, Creator> registry: TypeScript narrowing on the one-armed Phase 3 union forces a registry's unsupported-type guard to be unreachable dead code, while the if-branch surfaces a real TS exhaustiveness error when Phase 4 widens the union with 'sasanka'"
  - "Test wrapper uses vi.mock('node:crypto') with a real-pass-through wrapper around timingSafeEqual: vi.spyOn cannot redefine ESM namespace exports, and vi.mock with vi.hoisted lets us assert on call shape without sacrificing the real comparison semantics"

patterns-established:
  - "Auth backend module pair convention: <backend>.ts (the impl) + <backend>-factory.ts (dispatch) — Phase 4's SasankaApiKeyStore will follow the same shape and slot into the existing factory"
  - "Test ESM-namespace mocking: vi.mock + vi.hoisted wrapper that delegates to vi.importActual is the canonical pattern in this codebase for asserting on calls into Node built-ins (node:crypto, etc.) since vi.spyOn fails on ESM namespace exports"

requirements-completed: [AUTH-02]

# Metrics
duration: 6min
completed: 2026-04-29
---

# Phase 03 Plan 02: ApiKeyStore + InlineApiKeyStore + Factory Summary

**Pluggable ApiKeyStore interface with InlineApiKeyStore (constant-time HMAC-SHA256 comparison via timingSafeEqual on equal-length digests) and an extensible createApiKeyStore factory keyed off ApiKeyStoreConfig.type — the M2M API key validation core for AUTH-02, ready for plan 03-03 to wire into transport.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-04-29T13:05:49Z
- **Completed:** 2026-04-29T13:11:34Z
- **Tasks:** 3
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments

- `ApiKeyStore` interface — clean, single-method (`validate(key) -> Promise<AuthorizedPrincipal | null>`) async contract pluggable for Phase 4 backends
- `InlineApiKeyStore` — production-ready inline backend with HMAC-SHA256 + `timingSafeEqual` constant-time comparison; the per-instance random HMAC secret normalizes both candidate and configured keys to 32-byte digests so `timingSafeEqual` always sees equal-length buffers (length erased as a side-channel)
- `createApiKeyStore` factory — direct `if (config.type === 'inline')` dispatch with explicit `ClientAuthGateError` on unsupported types; Phase 4 adds the `'sasanka'` branch in the same function (TS exhaustiveness flags the missing branch when the union widens)
- 13 unit tests covering: valid key match, wrong key, missing/empty env var, length mismatch, multi-entry order (matches second when first doesn't), scopes default to `[]`, `authType='token'` per D-07, `timingSafeEqual` invoked on equal-length 32-byte buffers, factory `inline` dispatch, factory unsupported-type rejection, and an end-to-end smoke through the factory
- Full suite green: 155 test files / 3262 tests passing (was 154/3249 before this plan — +1 file, +13 tests, no regressions); typecheck clean; lint clean on touched files

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: Failing tests for InlineApiKeyStore** — `b093424` (test)
2. **Task 1 GREEN: Implement InlineApiKeyStore with HMAC constant-time comparison** — `79719c7` (feat)
3. **Task 2: createApiKeyStore factory keyed by config.type** — `c733aa1` (feat) — TDD-style: factory tests added in same edit, 3 new factory tests fail RED then pass GREEN inside the same commit since the factory module landed inline (single-pass red-then-green within the task per plan author's intent)
4. **Task 3: CHANGELOG entry** — `a46c33f` (chore)

_Task 1 produced two commits (test RED → feat GREEN). No refactor commit was needed; first GREEN implementation passed cleanly. Task 2 was a single commit — the small factory function plus its 3 tests landed atomically since splitting RED/GREEN across two micro-commits would obscure rather than illuminate the change._

## Files Created/Modified

- `src/auth/api-key-store.ts` *(new)* — `ApiKeyStore` interface with JSDoc anchoring the Phase 4 extension contract
- `src/auth/inline-api-key-store.ts` *(new)* — `InlineApiKeyStore` class; class-level JSDoc documents the constant-time strategy, the per-instance HMAC-key rationale (length normalization, not authentication), and why the HMAC is recomputed per call rather than pre-computed
- `src/auth/api-key-store-factory.ts` *(new)* — `createApiKeyStore(config, profileId, logger)` with direct `if`/`else` dispatch and an explicit `ClientAuthGateError` runtime guard; module-level JSDoc explains the registry-vs-if trade-off so a Phase 4 maintainer doesn't undo the choice
- `src/auth/api-key-store.test.ts` *(new)* — 13 vitest tests; test file uses `vi.mock('node:crypto')` + `vi.hoisted` to wrap `timingSafeEqual` so the timing-safety assertion can verify the contract (32-byte equal-length buffers) without sacrificing the real comparison semantics
- `CHANGELOG.md` — Appended bullet under existing `Unreleased > Added` documenting the new interface, store, factory, and the constant-time mechanism

## Decisions Made

- **Per-instance random HMAC secret as a length-normalization device.** The secret is generated once per `InlineApiKeyStore` instance and never leaves memory. It exists purely to make the HMAC outputs always-32-bytes — `timingSafeEqual` then operates on equal-length inputs regardless of raw key lengths, erasing length as a timing leak. The secret itself adds no meaningful confidentiality (an attacker with heap access has worse problems); the design intent is comparison-length normalization, not extra authentication. JSDoc on the field documents this so a future maintainer doesn't conclude "this is just an HMAC-with-random-key, we should derive it from a stable secret" and break the property.
- **HMAC recomputed per call, not pre-computed at construction.** `InlineApiKeyStore` targets small deployments (typically 1-5 keys). The per-call HMAC cost is negligible compared to a single inbound MCP request, and pre-computing digests would force mutable cache state plus env-var-rotation invalidation logic without measurable latency benefit at this scale. Phase 4's `SasankaApiKeyStore` uses a fundamentally different model (network call), so this trade-off does not propagate.
- **Empty string and undefined env-var values are equivalent ("not configured").** An env var explicitly set to `""` is still a misconfiguration, and treating it identically to "unset" prevents the surprise where a client sends an empty Authorization value and accidentally matches a misconfigured slot. The behavior is asserted directly in two tests.
- **Direct `if` branch instead of `Record<string, Creator>` registry.** `ApiKeyStoreConfig` is a one-armed discriminated union in Phase 3. With a registry, the unsupported-type guard would be unreachable dead code (TypeScript narrows `config.type` to `'inline'` already), and the compiler would not flag the missing branch when Phase 4 adds `'sasanka'` to the union. With an explicit `if` on `config.type === 'inline'`, Phase 4's union widening will surface a real TS exhaustiveness error here until the new branch lands. The factory function JSDoc documents this so a Phase 4 maintainer doesn't refactor it back.
- **`Logger` parameter retained on the factory even though it is unused for `'inline'`.** Phase 4's `SasankaApiKeyStore` will need a logger (network errors, retries, etc.). Including it now keeps the Phase 4 signature additive — no breaking change for `03-03`'s call site.
- **Test ESM-namespace mocking via `vi.mock` + `vi.hoisted` wrapper.** `vi.spyOn(nodeCrypto, 'timingSafeEqual')` fails because ESM namespace properties are not configurable. The pattern adopted here (`vi.mock` + `vi.hoisted` mock function + delegation to `vi.importActual`) lets the timing-safety assertion verify the contract while preserving real comparison semantics. This is now the canonical pattern in this codebase for asserting on calls into Node built-ins.

## Deviations from Plan

None — plan executed exactly as written.

The plan's draft factory body included an inline parenthetical noting that the registry pattern was removed because the union has only one variant in Phase 3; the implementation matches that recommendation verbatim. The plan called for a TDD flow on tasks 1 and 2; task 1 was executed strictly RED → GREEN as separate commits, and task 2 was executed as a single atomic commit (factory + 3 tests) since splitting the ~30-line factory across two micro-commits would obscure rather than illuminate. The TDD spirit was preserved: tests were written alongside the impl and verified to fail without the impl before the impl was added.

Two minor inline adjustments worth noting (none rise to a deviation):
- The test file's `vi.spyOn` approach failed against ESM (vitest emits `Cannot redefine property` for `node:crypto` namespace exports). Switched to `vi.mock` + `vi.hoisted` pass-through wrapper. This is a test-infrastructure nuance, not a plan deviation.
- One unnecessary `eslint-disable-next-line` comment was removed from the factory after lint surfaced it as an unused directive (`_logger` already matches the project's `^_/u` allowed-unused-vars pattern). Self-cleanup, not a Rule-1 deviation.

## Issues Encountered

- `vi.spyOn(nodeCrypto, 'timingSafeEqual')` threw `TypeError: Cannot redefine property` because ESM namespace properties are non-configurable. Resolved by switching to `vi.mock('node:crypto', ...)` + a hoisted spy wrapper that delegates to `vi.importActual`'s real implementation. Net result: timing-safety contract is verified end-to-end with the real comparison semantics intact.

## User Setup Required

None — `03-02` ships only the validation core. No environment configuration is required to land the change. Operators only need to set the env vars referenced by `key_from_env` once they configure a `client_auth_gate.api_keys.keys[].key_from_env` block on a profile, which `03-01` already validates as fail-fast at load time.

## Next Phase Readiness

- `ApiKeyStore` and `createApiKeyStore` are stable contracts for `03-03` (transport wiring + per-session resolver). The resolver in `03-03` will: (1) read `client_auth_gate.api_keys` from `HttpProfileContext` (already plumbed in `03-01`), (2) call `createApiKeyStore(config, profileId, logger)` once per profile at session-init, and (3) call `store.validate(rawKeyFromHeader)` per session.
- `SessionData.clientPrincipal` (reserved in `03-01`) is the assignment target for the resolved `AuthorizedPrincipal`.
- `authType: 'token'` on the returned principal matches D-07 and is the discriminator the policy layer (Phase 5) will use to differentiate API-key sessions from OIDC-JWT sessions.
- No blockers. Phase 4 (OIDC JWT gate) extension points are anchored in source: (a) the `if`/`else` in `api-key-store-factory.ts` will need a `'sasanka'` branch when `ApiKeyStoreConfig` widens; (b) the `Logger` parameter on the factory is already in place for the `SasankaApiKeyStore` constructor.

## Self-Check: PASSED

- All claimed files exist on disk.
- All four task commits present in `git log` (b093424, 79719c7, c733aa1, a46c33f).
- `npm run typecheck` exits 0.
- `npx vitest run src/auth/api-key-store.test.ts` — 13/13 tests passed.
- `npx vitest run -t "InlineApiKeyStore"` — 11/11 tests passed (the 11th match is the factory's e2e smoke whose name contains "InlineApiKeyStore").
- `npx vitest run -t "createApiKeyStore"` — 3/3 tests passed.
- `npm test` — 155 test files / 3262 tests passing, 0 failures, 0 regressions vs the 03-01 baseline (154/3249).
- `grep -q "InlineApiKeyStore" CHANGELOG.md` — match found.
- `npx eslint src/auth/api-key-store.ts src/auth/inline-api-key-store.ts src/auth/api-key-store-factory.ts src/auth/api-key-store.test.ts` — clean, 0 warnings/errors.

---
*Phase: 03-client-authentication-gate*
*Completed: 2026-04-29*
