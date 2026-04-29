---
phase: 03-client-authentication-gate
verified: 2026-04-29T13:35:00Z
status: passed
score: 13/13 must-haves verified
re_verification: false
---

# Phase 03: Client Authentication Gate Verification Report

**Phase Goal:** M2M clients can be authenticated via API keys before any upstream resource is consumed; resolved identity attached to session
**Verified:** 2026-04-29T13:35:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | A profile with a valid client_auth_gate.api_keys block loads without error | ✓ VERIFIED | `validateClientAuthGateProfile` in profile-loader.ts L80; 17 passing validator tests |
| 2 | A profile with api_keys.type='unknown' is rejected at load time | ✓ VERIFIED | `ALLOWED_API_KEY_TYPES = ['inline']` in validator; unsupported type throws `ClientAuthGateError` |
| 3 | SessionData carries a clientPrincipal field available for auth gate population | ✓ VERIFIED | `http-transport.ts L49: clientPrincipal?: AuthorizedPrincipal` in `SessionData` |
| 4 | Zod + JSON Schema stay in sync (check-schema-sync passes) | ✓ VERIFIED | `npm run check-schema-sync` exits 0; `clientAuthGateConfigSchema` at L15 of generated-schemas.ts; profile-schema.json L1756 has `ClientAuthGateConfig` |
| 5 | InlineApiKeyStore.validate() returns AuthorizedPrincipal for a configured key and null for unknown key | ✓ VERIFIED | inline-api-key-store.ts validates against env vars; 13 passing tests in api-key-store.test.ts |
| 6 | InlineApiKeyStore uses constant-time comparison (crypto.timingSafeEqual) to prevent timing attacks | ✓ VERIFIED | inline-api-key-store.ts L1: `import { createHmac, randomBytes, timingSafeEqual }`; HMAC-SHA256 digest on both inputs before compare |
| 7 | createApiKeyStore('inline', config, profileId, logger) returns InlineApiKeyStore | ✓ VERIFIED | api-key-store-factory.ts L31: `return new InlineApiKeyStore(profileId, config.keys)` |
| 8 | createApiKeyStore with unknown type throws ClientAuthGateError | ✓ VERIFIED | api-key-store-factory.ts L36: `throw new ClientAuthGateError(...)` |
| 9 | A session init with a valid API key resolves the principal and attaches it to the session with authType='token' | ✓ VERIFIED | http-transport.ts L2782-2783 + L3514 (createSession); Scenario 1 integration test passes |
| 10 | A session init with an invalid API key is rejected with HTTP 401 | ✓ VERIFIED | http-transport.ts L2793-2796; Scenario 2 integration test passes |
| 11 | With mode='optional' and no credential, the session is created and clientPrincipal remains undefined | ✓ VERIFIED | ClientAuthGate.validate() returns null; http-transport.ts L2783; Scenario 3 passes |
| 12 | With mode='required' and no credential, the session init is rejected with HTTP 401 | ✓ VERIFIED | ClientAuthGate throws ClientAuthGateError; caught in http-transport.ts L2784-2798; Scenario 4 passes |
| 13 | Session creation logger.info includes 'subject' and 'authType' structured fields when clientPrincipal is set | ✓ VERIFIED | http-transport.ts L3529-3530: `clientSubject: clientPrincipal?.subject, clientAuthType: clientPrincipal?.authType` |

**Score:** 13/13 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/types/profile.ts` | ClientAuthGateConfig, ApiKeyStoreConfig union types + Profile.client_auth_gate field | ✓ VERIFIED | L16 InlineApiKeyEntry, L32 ApiKeyStoreConfig, L43 ClientAuthGateConfig, L64 client_auth_gate? |
| `src/types/http-transport.ts` | SessionData.clientPrincipal optional field | ✓ VERIFIED | L49 clientPrincipal? AuthorizedPrincipal; also HttpProfileContext L128 and HttpTransportConfig L113 |
| `src/core/errors.ts` | ClientAuthGateError typed error | ✓ VERIFIED | L148-153: code 'CLIENT_AUTH_GATE_ERROR', name 'ClientAuthGateError' |
| `src/profile/client-auth-gate-validator.ts` | validateClientAuthGateProfile() fail-fast validator | ✓ VERIFIED | 126 lines; exports `validateClientAuthGateProfile` at L39 |
| `src/profile/client-auth-gate-validator.test.ts` | Unit tests for validator (valid + invalid configs) | ✓ VERIFIED | 289 lines; 19 test items covering all behavior bullets |
| `src/auth/api-key-store.ts` | ApiKeyStore interface | ✓ VERIFIED | 15 lines; exports `ApiKeyStore` interface at L13 |
| `src/auth/inline-api-key-store.ts` | InlineApiKeyStore implementation | ✓ VERIFIED | 84 lines; HMAC-SHA256 + timingSafeEqual; authType='token' |
| `src/auth/api-key-store-factory.ts` | createApiKeyStore() factory | ✓ VERIFIED | 39 lines; exports `createApiKeyStore` with inline branch + ClientAuthGateError fallback |
| `src/auth/api-key-store.test.ts` | Unit tests for InlineApiKeyStore and factory | ✓ VERIFIED | 255 lines; 16 test items; all 13 tests pass |
| `src/auth/client-auth-gate.ts` | ClientAuthGate class with validate() | ✓ VERIFIED | 81 lines; exports `ClientAuthGate`; no jose/JwksCache imports (Phase 4 deferred) |
| `src/auth/client-auth-gate.test.ts` | Integration tests for API key gate behavior | ✓ VERIFIED | 174 lines; 10 test items including Phase 4 deferral source-text guard |
| `src/transport/http-transport-client-auth.test.ts` | 8 integration scenarios for session-init gate flow | ✓ VERIFIED | 335 lines; all 8 scenarios present and passing |
| `src/transport/http-transport.ts` | client_auth_gate wiring in handlePost + clientPrincipal in createSession | ✓ VERIFIED | L2780-2805 gate execution; L3482 clientPrincipal param; L3514 session literal; L3529-3530 log fields |
| `src/mcp/mcp-server.ts` | getHttpProfileContext() returns client_auth_gate | ✓ VERIFIED | L739: `client_auth_gate: this.profile.client_auth_gate` |
| `CHANGELOG.md` | Entries for all three plans | ✓ VERIFIED | 3 bullet points under Unreleased > Added documenting ClientAuthGateConfig, InlineApiKeyStore, and ClientAuthGate wiring |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/profile/profile-loader.ts` | `src/profile/client-auth-gate-validator.ts` | `validateClientAuthGateProfile(profile)` call after enterprise auth validation | ✓ WIRED | L34 import; L80 call; result reassigned to `profile.client_auth_gate` |
| `src/types/http-transport.ts` | `src/auth/inbound-auth-principal.ts` | import AuthorizedPrincipal for clientPrincipal typing | ✓ WIRED | L14: `import type { AuthorizedPrincipal } from '../auth/inbound-auth-principal.js'` |
| `src/auth/inline-api-key-store.ts` | `node:crypto` | `timingSafeEqual` for constant-time key comparison | ✓ WIRED | L1: destructured import; L73: `timingSafeEqual(keyDigest, this.digest(configured))` |
| `src/auth/api-key-store-factory.ts` | `src/auth/inline-api-key-store.ts` | `new InlineApiKeyStore(profileId, config.keys)` in inline branch | ✓ WIRED | L4 import; L31 instantiation |
| `src/mcp/mcp-server.ts` | `src/types/http-transport.ts` | `getHttpProfileContext()` adds client_auth_gate to context | ✓ WIRED | L739: `client_auth_gate: this.profile.client_auth_gate` |
| `src/transport/http-transport.ts` | `src/auth/client-auth-gate.ts` | `ClientAuthGate.validate(token)` called BEFORE authConfigs guard in handlePost | ✓ WIRED | L38 import; L2780-2798 gate execution block; L2805 bypassed guard uses `!profileState.clientAuthGate &&` |
| `src/transport/http-transport.ts` | `src/types/http-transport.ts` | `session.clientPrincipal` populated in createSession() | ✓ WIRED | L3482 param; L3514 session literal assignment |
| `src/auth/client-auth-gate.ts` | `src/auth/api-key-store-factory.ts` | `createApiKeyStore()` called in constructor | ✓ WIRED | L4 import; L44: `this.apiKeyStore = createApiKeyStore(config.api_keys, profileId, logger)` |

---

### Data-Flow Trace (Level 4)

This phase produces session-init authentication logic, not UI rendering. The data flow is:

`Profile.client_auth_gate` → (mcp-server.ts `getHttpProfileContext()`) → `HttpProfileContext.client_auth_gate` → (http-transport.ts `getProfileState()`) → `ProfileRuntimeState.clientAuthGate` → (handlePost gate execution) → `resolvedClientPrincipal` → (createSession) → `session.clientPrincipal`

Each step is wired and produces real data (verified via integration tests and source inspection). No UI rendering component to check for hollow props.

| Data Path | Source | Produces Real Data | Status |
|-----------|--------|--------------------|--------|
| Profile → HttpProfileContext | mcp-server.ts L739 | Yes — passes through actual profile config | ✓ FLOWING |
| HttpProfileContext → ProfileRuntimeState | http-transport.ts L530-539 | Yes — constructs ClientAuthGate from config | ✓ FLOWING |
| Gate validation → resolved principal | inline-api-key-store.ts | Yes — env var lookup + HMAC compare | ✓ FLOWING |
| resolvedClientPrincipal → session | http-transport.ts L3514 | Yes — passed as last arg to createSession() | ✓ FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All 46 phase 03 tests pass | `npx vitest run <4 test files>` | 4 files, 46 tests passed | ✓ PASS |
| Schema sync maintained | `npm run check-schema-sync` | Exits 0: "profile-schema.json is synchronized" | ✓ PASS |
| No JWT code in client-auth-gate.ts | `grep jose/jwks-cache/jwtVerify client-auth-gate.ts` (import lines) | No import matches; JSDoc references only | ✓ PASS |
| All 12 task commits exist in git | `git log <12 hashes>` | All 12 hashes confirmed | ✓ PASS |

---

### Requirements Coverage

| Requirement | Source Plans | Description | Phase 03 Status | Evidence |
|-------------|-------------|-------------|-----------------|---------|
| AUTH-02 | 03-01, 03-02, 03-03 | M2M client API key validated before session establishment | ✓ SATISFIED | InlineApiKeyStore + ClientAuthGate wired into handlePost; invalid key → 401; valid key → session with clientPrincipal |
| AUTH-03 | 03-01, 03-03 | Client identity attached to session context and audit log (partial — API key path; JWT path Phase 4) | ✓ SATISFIED (partial) | `session.clientPrincipal` populated; `clientSubject`/`clientAuthType` in session-creation log; per-tool-call audit log is Phase 5; REQUIREMENTS.md marks as "Phase 3 (partial), Phase 4 (complete)" |

**Orphaned requirements check:** REQUIREMENTS.md traceability table assigns AUTH-02 and AUTH-03 to Phase 3. Both are covered by the plans. No other requirements are mapped to Phase 3. No orphans.

AUTH-03 partial completion is intentional and documented: the requirement has two parts — identity attachment (done: `session.clientPrincipal`) and per-tool-call audit log emission (Phase 5: OBS-01). REQUIREMENTS.md reflects this with "Phase 3 (partial), Phase 4 (complete)".

---

### Anti-Patterns Found

No blockers or warnings found. Inspected:
- `src/auth/client-auth-gate.ts` — no TODOs, no stubs; Phase 4 extension points documented in JSDoc only
- `src/auth/inline-api-key-store.ts` — no return null stubs; null returns are correct behavior (no match)
- `src/auth/api-key-store-factory.ts` — no placeholder implementations
- `src/profile/client-auth-gate-validator.ts` — no placeholder branches; sasanka rejected with explicit error

Phase 4 deferral comments (`// Phase 4 adds...`) are documentation only and are not stubs — they are anchors for the next plan, not incomplete implementations.

---

### Human Verification Required

None. All key behaviors are covered by automated tests:

- Valid/invalid API key → 401/200 tested via integration tests (Scenarios 1-2)
- mode=optional/required behavior tested (Scenarios 3-4)
- authConfigs guard bypass tested (Scenarios 5-6)
- Regression: profiles without client_auth_gate unchanged (Scenario 7)
- All gate exceptions → 401 (Scenario 8)
- Constant-time comparison contract verified via vi.mock wrapper test

---

### Gaps Summary

No gaps. All 13 observable truths verified, all required artifacts exist and are substantive and wired, all key links confirmed, both requirement IDs satisfied within planned scope, no blocker anti-patterns, 46 tests passing.

---

_Verified: 2026-04-29T13:35:00Z_
_Verifier: Claude (gsd-verifier)_
