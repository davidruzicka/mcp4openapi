---
phase: 03-client-authentication-gate
plan: 03
subsystem: auth
tags: [client-auth-gate, api-keys, http-transport, session-init, authorized-principal, integration-tests, typescript]

# Dependency graph
requires:
  - phase: 03-client-authentication-gate
    provides: ClientAuthGateConfig, ClientAuthGateError, SessionData.clientPrincipal, HttpProfileContext.client_auth_gate, validateClientAuthGateProfile (03-01); ApiKeyStore + InlineApiKeyStore + createApiKeyStore factory (03-02)
provides:
  - ClientAuthGate orchestrator class (Phase 3: API key path only)
  - ProfileRuntimeState.clientAuthGate field constructed lazily in getProfileState() from context.client_auth_gate
  - Inbound gate execution in handlePost AFTER enterprise auth check, BEFORE the authConfigs token-required guard
  - authConfigs guard bypass when gate is configured (mode='optional' allows anonymous sessions independently of authConfigs)
  - createSession() takes optional clientPrincipal as last parameter; populates session.clientPrincipal; logger.info('Session created') includes clientSubject + clientAuthType
  - mcp-server.ts::getHttpProfileContext() returns this.profile.client_auth_gate, completing the Profile -> HttpProfileContext -> profileState data flow
  - buildDefaultProfileContext() propagates this.config.client_auth_gate so single-profile mode mirrors the multi-profile flow
  - 8 integration tests in src/transport/http-transport-client-auth.test.ts pinning the full session-init gate matrix
  - 8 unit tests in src/auth/client-auth-gate.test.ts pinning Phase 4 deferral (no jose / jwks-cache imports or runtime calls)
affects: [04-oidc-jwt-gate, 05-observability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Inbound auth gate orchestrator decouples mode handling (required vs optional) from store implementation; the store returns null/principal, the gate decides 401 vs anonymous session"
    - "ALL gate exceptions mapped to HTTP 401 at the transport boundary to avoid leaking validator internals; warn log records errorType ('ClientAuthGateError' vs 'unknown') for ops visibility"
    - "authConfigs token-required guard bypass when client_auth_gate is configured: the gate is the inbound auth authority once present, and mode='optional' must allow anonymous sessions independently of authConfigs"
    - "Optional last-parameter additive evolution of createSession() — preserves all existing call sites with no breaking change"
    - "Source-text Phase 4 deferral guard: vitest reads the gate source file and asserts the absence of jose/jwks-cache imports and runtime calls, preventing accidental Phase 4 work landing in Phase 3"

key-files:
  created:
    - src/auth/client-auth-gate.ts
    - src/auth/client-auth-gate.test.ts
    - src/transport/http-transport-client-auth.test.ts
  modified:
    - src/transport/http-transport.ts
    - src/mcp/mcp-server.ts
    - CHANGELOG.md

key-decisions:
  - "Gate placement is AFTER the enterprise auth check and BEFORE the authConfigs token-required guard: enterprise tokens still gate first when configured, and the gate's mode='optional' branch must be reachable before the legacy authConfigs guard (which would 401 on missing token)"
  - "authConfigs guard bypass via `!profileState.clientAuthGate &&` prefix: the gate is the inbound auth authority once configured. Without the bypass, mode='optional' could not allow anonymous sessions on profiles that also declare authConfigs (a common case where authConfigs target the upstream API for downstream-aware tooling)"
  - "ALL gate exceptions map to 401 (not 500): documented in code + tested via Scenario 8. Internal validator errors (Phase 4 will see Sasanka HTTP failures, JWKS unavailability) must not surface upstream details to clients. The warn log captures errorType for operator distinguishability"
  - "ClientAuthGate constructed once in getProfileState() (not per-request): the underlying ApiKeyStore holds per-instance state (HMAC secret in InlineApiKeyStore) that must persist across requests; per-request construction would break the timing-safe comparison contract"
  - "No JwksCache injection in Phase 3: the API key path does not need it. Phase 4 will pass `this.enterpriseJwksCache` (or a dedicated cache) when the JWT path lands. The constructor signature is forward-compatible — Phase 4 only adds an optional parameter"
  - "Logger field on ClientAuthGate retained even though Phase 3 doesn't use it: Phase 4's JWT path will log JWKS misses, kid mismatches, etc. Removing the field now would make Phase 4 a breaking constructor change"
  - "Dedicated test file (http-transport-client-auth.test.ts) instead of appending to the 4127-line http-transport.test.ts: matches the existing http-transport-{auth-enforcement,upstream-validation,security,...}.test.ts segmentation pattern and keeps the new scenarios easy to find"

patterns-established:
  - "Single inbound gate (`profileState.clientAuthGate`) per profile, not per-session: gate state lives at the profile level, session lifecycle only carries the resolved principal. Phase 4 will reuse this pattern for JWT validation"
  - "Profile -> HttpProfileContext -> ProfileRuntimeState data-flow path is now the canonical wiring for inbound auth: types in Profile -> serialized via mcp-server.ts::getHttpProfileContext() -> consumed in http-transport getProfileState(). Phase 4's JwksCache injection will follow the same pipeline"
  - "Integration test pattern for session-init scenarios: mock req/res objects, call handlePost directly via `(transport as unknown as ...).handlePost(req, res)`, read profileStates internals to verify session state. Avoids spinning up an HTTP server while still exercising the full handlePost flow"

requirements-completed: [AUTH-02, AUTH-03]

# Metrics
duration: 10min
completed: 2026-04-29
---

# Phase 03 Plan 03: ClientAuthGate Wiring + Session clientPrincipal Attachment Summary

**ClientAuthGate orchestrator (API key path only) wired into HTTP transport session init: the gate runs after enterprise auth and before the legacy authConfigs guard, mode-aware (required = 401 / optional = anonymous), resolves AuthorizedPrincipal from the InlineApiKeyStore (authType='token'), attaches it as session.clientPrincipal, and emits clientSubject + clientAuthType in the session-creation log entry — closing AUTH-02 and the API-key-path portion of AUTH-03.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-04-29T13:14:27Z
- **Completed:** 2026-04-29T13:24:26Z
- **Tasks:** 3 (TDD on Task 1, direct edits on Tasks 2-3)
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- `ClientAuthGate` orchestrator: mode-aware (`required` vs `optional`), delegates to `ApiKeyStore.validate()` for the configured store, returns null only on `optional` + no-identity, throws `ClientAuthGateError` on `required` + no-identity. Phase 4 extension points (JWT routing slot, JwksCache injection plan) anchored in inline JSDoc.
- `getProfileState()` lazily constructs the gate from `context.client_auth_gate`; gate lives on `ProfileRuntimeState` so it persists across requests for the same profile (preserves the `InlineApiKeyStore` per-instance HMAC secret needed for constant-time comparison).
- `handlePost` runs the gate at the correct insertion point (after enterprise auth, before authConfigs guard); ALL gate exceptions map to HTTP 401 with a structured warn log distinguishing `ClientAuthGateError` from unknown error types.
- `authConfigs` token-required guard now bypasses when `clientAuthGate` is set: the gate is the inbound auth authority once configured, and `mode='optional'` must be able to allow anonymous sessions on profiles that also declare upstream `authConfigs`.
- `createSession()` gains optional `clientPrincipal` as the last parameter (additive — no existing call site broken). Session literal carries `clientPrincipal`; `logger.info('Session created')` includes `clientSubject` + `clientAuthType` structured fields (partial AUTH-03; Phase 5 audit log will read `session.clientPrincipal` for per-tool-call attribution).
- `mcp-server.ts::getHttpProfileContext()` returns `this.profile.client_auth_gate`, and `http-transport.ts::buildDefaultProfileContext()` propagates `this.config.client_auth_gate` — completing the Profile -> HttpProfileContext -> ProfileRuntimeState data flow path that 03-01 reserved.
- 8 unit tests for `ClientAuthGate` cover the full behavior matrix (valid key, invalid key + required, invalid key + optional, no token + optional, no token + required, default mode, no api_keys store + optional, Phase 4 deferral source-text guard).
- 8 integration tests for the full session-init flow (Scenarios 1-8 from the plan): valid key path with `session.clientPrincipal` populated, invalid key path with no session created, mode + authConfigs interaction matrix, regression guard for profiles without `client_auth_gate`, and the "all gate exceptions map to 401" contract for non-`ClientAuthGateError` failures.
- Full suite green: **3278/3278 tests passing**, +16 vs 03-02 baseline (3262); typecheck clean; lint clean on touched files.

## Task Commits

Each task was committed atomically; Task 1 followed strict TDD with separate RED/GREEN commits:

1. **Task 1 RED — failing tests for ClientAuthGate** — `316b91c` (test)
2. **Task 1 GREEN — implement ClientAuthGate orchestrator** — `579dfc7` (feat)
3. **Task 2 — wire ClientAuthGate into http-transport session init** — `5acd198` (feat)
4. **Task 3 — integration tests for the gate session-init flow + CHANGELOG** — `927db06` (test)

_Tasks 2-3 were not RED/GREEN-split: Task 2 was a multi-file structural change (ProfileRuntimeState extension + handlePost rewiring + createSession signature evolution) where the RED state would have been a wide cluster of typecheck failures rather than meaningful behavioral failures, and Task 3's integration tests passed on first run after Tasks 1-2 already provided the implementation. The TDD spirit was preserved: Task 1's tests were written and verified to fail before the gate orchestrator landed._

## Files Created/Modified

- `src/auth/client-auth-gate.ts` *(new)* — `ClientAuthGate` class. Class JSDoc anchors the Phase 3 vs Phase 4 split (API key now, JWT later) and documents why the mode-handling lives at the gate level (not the store level). `validate()` is mode-aware and Phase 4 extension points (JWT routing slot before the API key store call) are documented inline.
- `src/auth/client-auth-gate.test.ts` *(new)* — 8 unit tests; the last test reads the gate source file and asserts no `jose` / `jwks-cache` imports and no `decodeProtectedHeader`/`jwtVerify`/`createLocalJWKSet`/`new JwksCache` runtime calls — pinning the Phase 4 deferral as a positive build-time invariant rather than relying on planner discipline.
- `src/transport/http-transport-client-auth.test.ts` *(new)* — 8 integration scenarios driving `handlePost` with mock req/res; reads `profileStates` directly to verify `session.clientPrincipal`. Scenarios 5-6 are the load-bearing pins for the `!gate &&` bypass on the legacy authConfigs guard.
- `src/transport/http-transport.ts` — Imports for `ClientAuthGate`, `AuthorizedPrincipal`, `ClientAuthGateError`. `ProfileRuntimeState.clientAuthGate?: ClientAuthGate` field. `getProfileState()` constructs the gate from `context.client_auth_gate` (with structured info log). `buildDefaultProfileContext()` propagates `this.config.client_auth_gate`. `handlePost` runs the gate post-enterprise-auth / pre-authConfigs-guard and bypasses the legacy guard when the gate is set. `createSession()` takes optional `clientPrincipal`, populates the session literal, and logs `clientSubject` + `clientAuthType`.
- `src/mcp/mcp-server.ts` — `getHttpProfileContext()` returns `client_auth_gate: this.profile.client_auth_gate` (one-line addition that closes the data-flow gap from 03-01).
- `CHANGELOG.md` — Append to `Unreleased > Added`: documents the wired gate, its mode-aware behavior, the authConfigs guard bypass, and the AUTH-02 / partial AUTH-03 closure.

## Decisions Made

- **Gate placement after enterprise auth, before the authConfigs token-required guard.** Enterprise tokens (existing flow) keep priority when configured, and the gate's `mode='optional'` branch needs to short-circuit the legacy `authConfigs.length > 0 && !authInfo.token` guard that would otherwise 401 on every anonymous request. Tested by Scenarios 5-6.
- **`!profileState.clientAuthGate` prefix on the legacy authConfigs guard.** Once the gate is configured, it is the inbound auth authority. The legacy guard (`Authentication required` 401 when `authConfigs.length > 0 && !token`) targeted upstream-API-bound clients, but profiles with `client_auth_gate` may still declare `authConfigs` for downstream-aware tooling — without the bypass, `mode='optional'` would never reach `200`. Scenario 5 fails without this prefix (confirmed empirically during planning).
- **ALL gate exceptions map to HTTP 401, not 500.** Documented as Scenario 8 of the integration tests. The gate's exception path must not leak validator internals (Phase 4 will see Sasanka HTTP body fragments, JWKS misses, etc.) to clients. The warn log records `errorType: 'ClientAuthGateError' | 'unknown'` so operators can distinguish expected auth rejections from unexpected store failures without leaking the failure detail to the wire.
- **Gate constructed once per profile in `getProfileState()`, not per-request.** The underlying `InlineApiKeyStore` holds per-instance state — specifically the HMAC secret used for constant-time comparison. Per-request construction would generate a fresh HMAC secret each time, but more importantly it would re-walk the entries array and re-allocate, both wasteful at this scale. The gate lifecycle ties to `ProfileRuntimeState` which is itself lazily memoized.
- **No `JwksCache` injection in Phase 3.** The API key path does not consult JWKS, and the Phase 4 plan calls for the same `enterpriseJwksCache` (or a dedicated `clientAuthJwksCache`) injection that the existing enterprise auth provider uses. The constructor signature is forward-compatible: Phase 4 will add an optional parameter without breaking the Phase 3 call site.
- **Logger field retained on the gate even though Phase 3 doesn't emit through it.** Phase 4's JWT path will log JWKS unavailability, kid mismatches, and OIDC discovery failures. Removing the field now would force Phase 4 to add a breaking constructor parameter.
- **Phase 4 deferral pinned by source-text guard, not just JSDoc convention.** `client-auth-gate.test.ts` reads the gate source file and asserts the absence of `jose` / `jwks-cache` imports and `decodeProtectedHeader`/`jwtVerify`/`createLocalJWKSet`/`new JwksCache` runtime calls. The regex matches imports/calls only, not JSDoc text — so the file can document Phase 4 plans inline (necessary for the next planner) without tripping the guard.
- **Dedicated `http-transport-client-auth.test.ts` file, not an append to the 4127-line monolith.** The codebase already segments transport tests into `http-transport-{auth-enforcement,upstream-validation,security,cors,payload,rate-limit,config}.test.ts`; adding `http-transport-client-auth.test.ts` is the established pattern.

## Deviations from Plan

**Process deviation (worktree state):** When this plan started, plans 03-01 and 03-02 had been committed on the `dr-client-auth-gate-api-keys` branch (in `/workspace`) but the worktree at `/workspace/.claude/worktrees/agent-ac69c1c6396f5375f` was branched off `main` (`81054d3`) and did not contain those commits. I merged `dr-client-auth-gate-api-keys` into the worktree branch (clean fast-forward + new commits) so the prerequisite types, validator, and `InlineApiKeyStore`/factory were available to build on. This is a Rule 3 fix (blocking issue: missing prerequisite files), not a code deviation.

**Code deviations (Rules 1-3):** None — the plan's intent was followed exactly: API-key-only gate, no JWT/JWKS code, gate placement after enterprise auth and before authConfigs guard, additive `createSession` signature, structured logger fields, and the eight integration scenarios.

**Minor refinements:**
- The plan's draft regex for the Phase 4 deferral test matched any occurrence of `decodeProtectedHeader` / `jose` / `jwks-cache` in the source file. The first GREEN run failed because the JSDoc comment legitimately documents the Phase 4 plan ("Phase 4 inserts JWT routing here, based on `decodeProtectedHeader`"). I tightened the regex to match `import` statements and runtime calls only (`decodeProtectedHeader(`, `jwtVerify(`, `createLocalJWKSet(`, `new JwksCache(`) — preserves the deferral guarantee while letting the file document the future plan inline.
- `buildDefaultProfileContext()` propagation of `this.config.client_auth_gate` was added (the plan called this out explicitly under Change B, but it's worth flagging as a meaningful one-line addition that closes single-profile mode parity with multi-profile mode).
- One unused `eslint-disable` directive on the gate's `logger` field was cleaned up after lint surfaced it (the project's unused-vars config already permits the field to remain unused without needing the disable comment).

## Issues Encountered

- **Worktree was branched off `main`, not `dr-client-auth-gate-api-keys`.** Initial file reads showed plans 03-01 and 03-02 prerequisites missing on disk despite their commits existing on `dr-client-auth-gate-api-keys`. Resolution: merged the prerequisite branch into the worktree branch (clean fast-forward of 10 commits) so prerequisite types, validator, and the inline-store factory were available to build Task 1 on top of.
- **Phase 4 deferral test false positive on JSDoc.** Tightened the regex (see deviations above) so it pins the import/runtime contract rather than any source-text mention — the file can now document the Phase 4 design inline as a roadmap aid for the next planner.

## User Setup Required

None for this plan to land. To exercise the gate end-to-end an operator must:
1. Configure `client_auth_gate.api_keys` on a profile (validated at load time by 03-01's validator).
2. Set the env vars referenced by `key_from_env` (also validated fail-fast at load time).
3. Send `Authorization: Bearer <key>` on the inbound `POST /mcp` initialize request.

No CLI tooling, no migrations, no deployment changes required by this plan.

## Next Phase Readiness

- **AUTH-02 closed.** Inline API key validation works end-to-end at session init: invalid key returns 401, valid key resolves identity, and the resolved principal is on the session.
- **AUTH-03 partially closed.** `session.clientPrincipal` is populated and logged at session creation. Per-tool-call audit log emission (Phase 5) reads the principal from session state — no further `SessionData` shape changes needed for that work.
- **Phase 4 (OIDC JWT gate) extension points are anchored in source:**
  - `ClientAuthGate.validate()` documents the exact slot where JWT routing inserts (BEFORE the API key store call).
  - `ClientAuthGate` constructor signature is additive — Phase 4 will accept an optional `JwksCache` parameter.
  - `getProfileState()` already wires `enterpriseJwksCache`; the Phase 4 plan can pass it (or a dedicated `clientAuthJwksCache`) at the gate construction site.
  - The Phase 3 deferral test (`client-auth-gate.test.ts:'Phase 3 sanity'`) will start failing the moment Phase 4 lands the JWT imports — this is intentional and signals the deferral guard has been intentionally lifted.
- **Phase 5 (Audit log) extension points:** `session.clientPrincipal` is the single read site for per-tool-call attribution. The `clientSubject`/`clientAuthType` fields are already in the session-creation log entry; per-tool-call audit emission is a separate Phase 5 deliverable.
- **No blockers.** The `dr-client-auth-gate-api-keys` branch (where 03-01 and 03-02 originally landed) and the worktree branch are now consistent and can be reconciled by the orchestrator without further intervention.

## Self-Check: PASSED

- All claimed files exist on disk.
- All four task commits present in `git log`: `316b91c`, `579dfc7`, `5acd198`, `927db06`.
- `npm run typecheck` exits 0.
- `npx vitest run src/auth/client-auth-gate.test.ts` — 8/8 tests passed.
- `npx vitest run src/transport/http-transport-client-auth.test.ts` — 8/8 tests passed.
- `npx vitest run -t "client auth gate|ClientAuthGate|clientPrincipal"` — 29/29 tests passed (8 + 8 + 13 from api-key-store.test.ts whose names match the filter).
- `npm test` — 157 test files / 3278 tests passing, 0 failures, 0 regressions vs the 03-02 baseline (155/3262 + 16 new tests = 157/3278).
- `npx eslint src/auth/client-auth-gate.ts src/auth/client-auth-gate.test.ts src/transport/http-transport-client-auth.test.ts src/transport/http-transport.ts src/mcp/mcp-server.ts` — clean, 0 warnings/errors.
- `grep -n "clientPrincipal" src/transport/http-transport.ts` — 5 occurrences (parameter, session literal, logger fields, manual verify confirms it is set in createSession and logged).
- `grep -n "ClientAuthGate" src/transport/http-transport.ts` — gate is imported, constructed in `getProfileState`, and called in `handlePost` with the correct insertion point and bypass on the legacy authConfigs guard.

---
*Phase: 03-client-authentication-gate*
*Completed: 2026-04-29*
