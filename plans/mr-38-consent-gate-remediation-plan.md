# MR 38 Consent Gate Remediation Plan

## Purpose

This plan converts the security and correctness audit of MR 38 into an implementation sequence. It is written for both the implementation agent and the reviewer who will verify that the fixes address the actual failure modes rather than only changing local symptoms.

The original audit reviewed revision `30a85d6`. Commits `30a85d6`, `9843e7b`, and `e1b06d2` already fixed most of the original findings. This revision of the plan was re-verified against the working tree at `7e11551` by six independent reviews (codebase alignment, security, feasibility, project standards, test strategy, fresh perspective). Sections below carry only residual work; everything the audit originally reported and that is now fixed is listed in Appendix A so no agent re-implements it.

MR 38 adds an OIDC-backed human consent gate for sensitive upstream MCP profiles. The intended invariant is:

> A tool call on a required-consent profile is allowed only when the request is bound to a verified OIDC human identity and that identity has accepted the current rules version for the same profile and issuer/tenant context.

**Implementation status: complete except two deferred items.** Sections 0 to 10 are implemented and verified; see Appendix B for evidence and deviations. Still open: only the two section 8 items deferred by design.

### Residual findings at `7e11551`

Identity and enforcement:

1. `tools/list` reaches upstream dispatch with no consent check. `handleUpstreamToolsList` obtains the raw Entra delegated access token and connects upstream before any consent lookup runs.
2. Consent enforcement is opt-in at the call site and fails open when the enforcer is absent, rather than being driven by the profile's own `required` flag.
3. `ConsentGate.assertConsent()` checks `subject` and `issuer` only, never `authType`. An `enterprise` or `token` principal carrying a matching subject and issuer satisfies a `profile_oauth` gate.
4. `consentEvidenceKey` does not normalize the issuer, while the transport guard does. A trailing-slash difference passes the guard and then silently misses the evidence record.
5. The direct OAuth token-endpoint `refresh_token` grant still relies on process-local refresh identity after restart.

Configuration and storage:

6. The environment upstream override replaces the complete upstream object including `transport.url`, and validates neither `html_description_policy` nor `tool_description_length_policy`. This is **not** a security boundary: the environment is set by the administrator, who already controls `profile.json` and the deployment. It is a config-safety gap. A copied or stale override silently weakens the policy or points the connection elsewhere with no error, and unlike `profile.json` it is not in git and not code-reviewed. Treat it the same way the existing `tools.allow`/`tools.deny` broadening guard is already treated.
7. Evidence directories and files rely on process umask instead of enforced restrictive permissions.
8. A missing evidence path silently selects volatile in-memory storage, with no production signal in the codebase to key a hard failure on.

Lifecycle, absent from both the code and the original audit:

9. Consent has no TTL, no revocation path, and no tombstone record. A `rules_version` rollback reactivates every prior grant.
10. `rules_version` is a free string with no binding to the rules text. `rules_summary` and `education_resource` can change with no version bump, so "subject X accepted v1" does not identify what v1 said.
11. There is no per-use audit record. Evidence records grants only, so "what did the agent do under this consent" has no answer.
12. Re-consent after a gateway restart is a dead end. Envelope recovery restores a valid principal, so the client receives no 401 and never re-runs OAuth; every tool call returns a consent error whose page tells the user to reconnect the server manually.

Availability:

13. `pendingConsentApprovals` is a process-local FIFO capped at 1000, populated by unauthenticated `GET /authorize`, and evicts oldest-first. It is both a DoS target and broken behind more than one replica.

Two claims from the original audit were checked and do **not** hold, and must not be acted on:

- "Issuer normalization is performed in the OIDC verifier but not consistently at the OAuth provider boundary." `normalizeIssuer` is already applied at the provider boundary (`src/auth/oauth-provider.ts:32,177`), on rehydrated refresh identity (`:1161`), and in envelopes (`src/auth/token-envelope.ts:241`). The real gap is the evidence-key lookup, finding 4 above.
- "Evidence keys rely on raw delimiter concatenation of attacker-controlled fields." `consentEvidenceKey` uses `JSON.stringify` over a five-tuple, which escapes delimiters. No collision could be constructed. Keep the regression test at `src/auth/consent-evidence-store.test.ts:47`; do not re-engineer the encoding.

Two structural safety properties hold today but only by accident of wiring, not by a control, and must be converted into enforced invariants plus regression tests:

- Stdio has no wired upstream client (`src/core/index.ts:388-397` builds a bare `MCPServer` and never calls `setGetUpstreamClient`).
- Non-initialize HTTP requests without `Mcp-Session-Id` are rejected at `src/transport/http-transport.ts:3112-3116`, before `messageHandler` runs at `:3575`.

## Current Status at `7e11551`

**Historical snapshot taken before the work started.** Every "Open" row below has since been addressed; read Appendix B for the current state and do not treat this table as a live status view.

Status values describe verified code inspection. They do not complete the checkboxes below; a checkbox may be marked complete only with the focused test or recorded decision required by that item.

| Area | Status | Current assessment |
| --- | --- | --- |
| Encrypted-token recovery principal | Implemented | Recovery retains verified subject, issuer, and tenant (`http-transport.ts:3462-3476,3559-3570`) and suppresses the `clientId` fallback when `consent_gate.required` (`:3561`). |
| Session refresh after encrypted recovery | Implemented | Refresh passes recovered identity into token exchange (`http-transport.ts:4903-4917`) and reissues an identity-bearing envelope (`:4934`). |
| Direct OAuth `refresh_token` grant after restart | Partial | `http-transport.ts:2233` calls `exchangeRefreshToken` with no identity; `oauth-provider.ts:1155-1162` falls back to the process-local map. |
| Evidence binding | Implemented | Five-part structured key: subject, issuer, tenant, profile, rules version (`consent-evidence-store.ts:47-63`). |
| Evidence-key issuer normalization | Open | `consent-gate.ts:46-57` forwards `principal.issuer` raw; only the transport guard normalizes (`http-transport.ts:4705`). |
| File-store queue recovery | Implemented | Failed record rejects its caller while the queue resets (`consent-evidence-store.ts:115-121`). |
| File-store confidentiality | Open | `mkdirSync`/`appendFileSync` pass no `mode` (`consent-evidence-store.ts:141-143`). |
| Evidence-store production selection | Open | Factory takes only a logger and silently returns the in-memory store (`consent-evidence-store-factory.ts:14-21`). No production signal exists in the codebase. |
| Evidence file growth | Open | Append-only, no rotation or size cap; `has()` does `statSync` plus full `readFileSync` reparse per call. |
| Softeria read-only tool boundary | Implemented (unvalidated) | Exact 23-name allow-list (`profiles/softeria-sharepoint/profile.json:37-61`), mirrored in the test profile and `env.example:86`. Never validated against a real catalog until now; see item 5.1. |
| Environment override tool policy | Implemented | `validateEnvironmentToolPolicy` (`upstream-mcp-config.ts:99-133`) constrains `tools.allow`/`tools.deny`. |
| Environment override connection target | Open (config safety) | `upstream-mcp-config.ts:295` substitutes the whole env object including `transport.url`; `validateUpstreamUrl` (`:174-195`) checks scheme, credentials, and fragment only. Administrator-set, so not a trust boundary; the risk is a silent misconfiguration, not an attacker. |
| Environment override sanitization policy | Open (config safety) | `html_description_policy` and `tool_description_length_policy` have no override validation, so a stale override can downgrade either to `allow` with no error. |
| Upstream-only consent contract | Implemented | `consent-gate-validator.ts:88-100` rejects missing `upstream_mcp` and non-empty local `tools[]`. |
| Consent enforcement chokepoint | Open | `tools/list` is ungated (`mcp-server.ts:2142,2677-2691`); `tools/call` enforcement is conditional on `this.httpTransport?.assertSessionConsent` (`:1807`); `assertSessionConsent` returns success when `consentGate` is unset (`http-transport.ts:4700`). |
| Runtime OAuth identity-source contract | Open | No `authType` check in `consent-gate.ts` or `http-transport.ts:4703-4708`. |
| Approval-token human/session binding | Decision required | One-time, 5-minute, fingerprint-bound over all seven OAuth parameters (`http-transport.ts:2094-2098,2129-2151`), with `form-action 'self'` and pre-render `redirect_uri` validation (`:2052,2142`). No realistic fixation or CSRF exploit found. Residual: the token proves a POST happened, not that a human read the rules. |
| Approval-store availability | Open | FIFO cap 1000, unauthenticated population, oldest-first eviction (`http-transport.ts:2074-2078,2124-2128`). Process-local, so broken behind a non-sticky load balancer. |
| Consent lifecycle (TTL, revocation, rules pinning, use audit) | Open | Not designed. No TTL (`consent-evidence-store.ts:66`), no revoke or tombstone API, `rules_version` unpinned to rules text, no per-call audit record. |
| Multi-replica evidence backend | Open follow-up | File backend is single-node. Note that the class docstring still claims cross-replica visibility, which is both wrong and unsound; see item 4.4. |

## Scope and Non-Goals

This plan covers the consent-gate feature and the Softeria profile boundary. It does not redesign unrelated OAuth flows, enterprise authorization, or the general upstream transport.

The recommended scope decision is **upstream-only consent in this iteration**, and it is already implemented and validated. Supporting consent for local OpenAPI tools would be a separate design change requiring a common authorization boundary.

The implementation must preserve these existing security properties:

- OIDC issuer, audience, signature, expiry, nonce, algorithm, discovery, JWKS-origin, and SSRF checks remain enforced.
- A missing verified subject on a **consent-gated** profile must fail closed and must never fall back to OAuth `clientId`. Non-consent profiles retain the existing `clientId`-subject fallback; this is deliberate, tested at `http-transport.test.ts:4248`, and recorded in `CHANGELOG.md:14`. Do not remove it.
- Approval tokens remain one-time, short-lived, and bound to the complete OAuth request.
- A rules-version change invalidates prior consent.
- OAuth access and refresh tokens remain secret and must not appear in logs or error messages.
- The durable multi-replica evidence backend remains a separate operational follow-up unless this work explicitly implements it.
- `consent-gate-validator.ts` requires the **static** `upstream_mcp` field for required consent. This is stricter than the effective-config check the earlier plan revision asked for. Keep the static requirement; do not relax it to accept an env-only upstream.

## Work Classification

The original plan had roughly 100 checkboxes for six genuinely open items, which invites stalling and re-implementation of merged code. Work is now split three ways.

**Blocking for merge:** sections 0, 1, 2, 3, 4, 5, 6.
**Test backfill:** section 7. Regression coverage for already-shipped behavior, tracked as one work item rather than fifty boxes.
**Deferred with a recorded reason:** section 8.

All new tests belong in unit or integration scope under `src/` (`src/**/*.test.ts`, `src/testing/*.test.ts`). `vitest.config.ts` excludes `tests/e2e/**` from `npm test` deliberately, because the e2e suite needs broader network access than the standard environment grants. Do not plan coverage that only works in e2e.

## 0. Decisions and Baseline

Every decision below blocks coding in a later section. Record the outcome inline in this file before starting section 1. Decision items are complete when the decision is written down here or in `docs/`; the no-code-inspection rule in the Definition of Done does not apply to them.

- [x] **D1 Refresh identity source.** Decided: envelope the refresh token. Return an encrypted `mcp4.v1r.*` refresh envelope binding `{rt, sub, iss, tid, client_id}` built with the existing `deriveTokenKey`/`encryptTokenPayload` helpers; the direct grant decrypts it and passes the identity through the `rehydratedIdentity` parameter that `exchangeRefreshToken` already accepts (`oauth-provider.ts:1148`). A non-envelope refresh token on a consent-gated profile is rejected with `invalid_grant` (fail closed, client re-runs OAuth) instead of minting an identity-less token. **Prerequisite, verified open:** `MCP4_OAUTH_KEY` is currently optional - its absence only logs a warning (`http-transport.ts:219-224`) - so `consent_gate.required === true` without a token key must become a hard startup failure alongside the D2 evidence-path check. Blocks section 2.
- [x] **D2 Production signal.** Decided (review issue 4A): no environment convention. `createConsentEvidenceStore` takes resolved config `{ evidencePath, consentRequired }` instead of reading `process.env`; `consentRequired && !evidencePath` is a hard startup failure regardless of environment. Blocks section 4 and section 6.
- [x] **D3 Consent lifetime and revocation.** Decide TTL or max-age, whether a tombstone/revocation record exists, and what an operator runs to revoke one subject. Blocks section 3. Doing this now is cheap because section 3 already changes the record shape; doing it after the JSONL format ships is not. Partially decided (review issue 15B): revocation is effective immediately, no positive-result cache. Adding a cache later requires reopening D3, because a cache introduces revocation latency that must then be documented as an operational bound.
- [x] **D4 Rules pinning.** Decided: `ConsentEvidence` gains `rules_hash` = sha256 over canonical JSON of `{rules_version, rules_summary ?? null, education_resource ?? null}`, computed at profile load. Per R7 the gate compares stored hash against current and treats a mismatch as no consent, so editing `rules_summary` forces re-consent even without a version bump - document that operational consequence. The external `education_resource` page is **not** pinned (the gateway cannot verify remote content); state that limitation plainly rather than adding an unverifiable admin-supplied document hash. SHA-256 is correct here and must not be swapped for scrypt: the scrypt migration (`token-envelope.ts:18-20,89`, `TODO.md:392`) replaced SHA-256 only as a **passphrase KDF**. `rules_hash` is a content digest over public configuration text, matching the existing SHA-256 uses at `oauth-provider.ts:1035`, `enterprise-replay-store.ts:42`, `enterprise-policy.ts:44`, `cache-key-builder.ts:37,58`, and `http-transport.ts:2097`. Blocks section 3.
- [x] **D5 Per-use audit.** Decided (review issue 16A): audit goes to the structured logger with a pseudonymized subject, not to the evidence store. `ConsentEvidence` is unchanged by D5, so section 3 breaks the JSONL format once. A durable audit sink stays a separate follow-up (section 8).
- [x] **D6 Re-consent flow.** Decided (review issue 3A): a consent miss returns 401 with the consent URL in `WWW-Authenticate` and invalidates the session/token **once** per subject per `rules_version`; subsequent misses return the typed `ConsentRequiredError` without invalidating. This bounds the OAuth restart loop that unconditional invalidation would create, because completing OAuth does not by itself record consent. Must be implemented together with D7, since the loop only closes if the OAuth restart renders the approval screen.
- [x] **D7 Approval interaction contract.** Decided: the contract is "verified OIDC identity plus acknowledgement of the rules version within the same OAuth request". Add a `__Host-` consent cookie (HttpOnly, Secure, SameSite=Lax, Path=/) set when the approval form renders, carrying a random id also held in the pending-approval entry; the POST must present a matching cookie **and** one-time token **and** request fingerprint. A cookie-less POST is rejected, since the flow is browser-only by construction. Documentation must say that browser and human presence are not proven and that identity comes from OIDC. Combine with the section 6 rework: key pending approvals by fingerprint and store the cookie id in the value, which is self-limiting and removes the eviction DoS in one change. Follow-up, not this iteration: moving acknowledgement after ID-token verification would bind acceptance to the authenticated subject rather than to the request, but it collides with the D6/R3 401 restart path. Blocks section 6.
- [x] **D8 Multi-audience.** Decided: implement OIDC Core 3.1.3.7 rules 4-5 in `oidc-identity-verifier.ts` - when `aud` is an array with more than one entry, require `azp` and require `azp === expected client id`; whenever `azp` is present, require the same equality. `jwtVerify`'s `audience` option accepts any array containing the value (`:52-57`) and `azp` is never read today. **Moved out of section 8 into section 1**: it is the subject the entire gate rests on, roughly ten lines plus three tests. Do not reject single-element `aud` arrays - they are legal and common.
- [x] Confirm the implementation branch against the current repository state; preserve unrelated worktree changes.
- [x] Record baseline results of `npm test`, `npm run lint`, and `npm run validate -- profiles/softeria-sharepoint/profile.json`, separating pre-existing failures from regressions.

## 0.1 Pre-Implementation Review Decisions (2026-08-12)

Outcome of the interactive pre-implementation review. Each item is binding on the section it names; where a decision conflicts with the older wording of a section, this section prevails.

Corrections to plan text found during the review, verified against the working tree:

- Path: `pseudonymizeSubject` is at `src/auth/observability-pseudonym.ts:6`, not `src/observability/observability-pseudonym.ts`. Output format is `pseudonym-sha256-<32 hex>` and is asserted at `observability-pseudonym.test.ts:18`, `mcp-server.test.ts:5723`, `http-transport-client-auth.test.ts:508`.
- Cost model: `FileConsentEvidenceStore.has()` does **not** reparse the file per call. `reloadIfChanged()` reloads only when `mtimeMs` differs (`consent-evidence-store.ts:181`) and `persistRecord` refreshes the watermark after its own append (`:153`). Steady state is one `statSync` per call; a full reparse happens only after an external write.
- Test claim: the §1 assertion that `toBeInstanceOf(ConsentRequiredError)` "cannot distinguish a correct rejection from a key-shape regression that rejects everything" is too strong. `consent-gate.test.ts` contains a suite-level positive control ("passes when consent was already recorded"), which such a regression would fail. The real gap is that all seven gate tests use `InMemoryConsentEvidenceStore` only.
- The broadening guard **is** covered, in `src/profile/softeria-profile.test.ts:89,99,111`. §5.3's "no direct coverage of `validateEnvironmentToolPolicy` at all" is true only of `upstream-mcp-config.test.ts`.
- Source paths in this plan omit directories. Actual locations: `src/mcp/mcp-server.ts`, `src/mcp/mcp-server-manager.ts`, `src/profile/upstream-mcp-config.ts`, `src/auth/consent-*.ts`, `src/transport/http-transport.ts`.

Architecture:

- **R1 (section 1).** The consent chokepoint is the injection seam: wrap the function passed to `setGetUpstreamClient` in `mcp-server-manager.ts:80` with a consent-asserting decorator. Remove the caller-side consent branch at `mcp-server.ts:1807`. `UpstreamConnectionManager` stays unaware of consent, avoiding the pooled-client-serves-non-consented-session trap.
- **R2 (section 1).** Gate ownership moves to profile scope: `MCPServerManager` constructs a `ConsentEnforcer` per profile from resolved profile config plus the evidence store; `httpTransport` supplies only a principal lookup (`getSessionClientPrincipal`, already public at `http-transport.ts:4694`). This removes the upward server-to-transport dependency and makes "required consent cannot dispatch without an enforcer" a wiring property rather than two runtime checks in two layers.
- **R3 (section 1, section 6).** D6 as recorded above: bounded single invalidation, not unconditional.
- **R4 (section 4).** One deployment constraint, not three doc notes. Factory takes resolved config (D2), startup fails hard when consent is required with no evidence path, and the sticky-session / single-replica requirement is written once and referenced from sections 4, 6, and 9.

Code quality:

- **R5 (section 6).** Split the pseudonymization bullet. Now: delete the inline hash at `http-transport.ts:665` and call `pseudonymizeSubject`. Later and separately: keying/salting, which needs a key source, rotation policy, missing-key behavior, and stable output across restarts. Do not bundle them.
- **R6 (section 5.3).** Add `validateEnvironmentOverride(staticUpstream, envUpstream)`, called **unconditionally** whenever an env override resolves, driven by a declarative rule table (no-broadening for tools, no-downgrade for `html_description_policy` and `tool_description_length_policy`, optional origin check as a row). Keep `validateEnvironmentToolPolicy` as one rule inside it. New plan item: the call-site condition at `upstream-mcp-config.ts:291` currently skips all override validation when the static profile declares no `tools` policy - that hole must close.
- **R7 (section 3).** Store contract changes from `has() -> boolean` to a lookup returning the latest record plus revocation state. TTL, tombstone, `rules_hash`, and rules_version monotonicity are evaluated in `ConsentGate`, not per store implementation. Land with the JSONL shape change so the format breaks once.
- **R8 (section 1, section 3).** `ConsentRequiredError.details` gains a machine-readable `reason` (`no_principal` | `auth_type_mismatch` | `issuer_mismatch` | `no_evidence` | `expired` | `revoked`), asserted in every negative test and used to select the R3 401-versus-error behavior. Log the specific reason; return a generic one to the client, since `issuer_mismatch` detail to an unauthenticated caller is an information leak.

Tests:

- **R9 (section 1, section 7).** One shared store-contract suite run parametrized over `InMemoryConsentEvidenceStore` and `FileConsentEvidenceStore`, and `ConsentGate` tests parametrized over both stores. Fix the §1 justification sentence per the correction above.
- **R10 (section 1, section 7).** R1 relocates enforcement, so `mcp-server.test.ts:4295,4312` must be **retargeted, not merely verified**: assert that the upstream client factory spy is never invoked, for `tools/call` and `tools/list`, plus a manager-level test that a `required: true` profile with no principal source refuses dispatch. Move these two tests out of the §7 "verify only" list.
- **R11 (section 5.3).** Generic rule coverage lives in `upstream-mcp-config.test.ts`, one test per rule-table row including the no-static-tools-policy case; `softeria-profile.test.ts` keeps one integration assertion with the real profile and a realistic bad override. Do not duplicate message-string assertions across both files.
- **R12 (section 10).** Per residual finding 1-13, commit a test demonstrated failing against current `HEAD` before its fix, and record the failing output in the results file. Coverage stays a reporting step; no vitest thresholds are added.

Performance:

- **R13 (section 4).** Move the file store to `fs/promises` behind the already-async `ConsentEvidenceStore` interface, keeping the serialized write queue. Sync fs on the dispatch path blocks the whole event loop, and R1 widens the gate to `tools/list`. The serialization test at `consent-evidence-store.test.ts:175` becomes meaningful and must be strengthened.
- **R14 (section 4).** Track `(size, mtimeMs)` and parse incrementally from the last known byte offset: read only the new tail on growth, full reload on shrink or mtime-without-growth, never advance the watermark from a stat that did not accompany a read. Guard partial trailing lines by re-reading from the last newline. This replaces "delete the cross-replica claim" - it fixes the missed-peer-append bug instead of documenting it away. Keep the size cap with `ConsentEvidenceStoreError` and a documented compaction procedure.
- **R15 (section 3).** No consent-result cache. Every dispatch consults the store, so revocation is effective immediately. See D3.
- **R16 (section 9).** D5 as recorded above: audit to the structured logger, pseudonymized subject via the R5 helper, evidence record shape unchanged.

## 1. Close the Enforcement Boundary

The gate is currently applied by callers rather than at the dispatch boundary, and one dispatch path skips it entirely. This is the highest-severity residual work: on a fresh user or after a rules bump, `tools/list` transmits the user's raw Entra delegated token upstream before any human has accepted anything.

- [x] Enforce consent inside a single chokepoint that every upstream dispatch must pass through (`getUpstreamClientFn` / `UpstreamConnectionManager.getOrConnect` or a wrapper both call sites use), instead of at each caller.
- [x] Gate `handleUpstreamToolsList` (`mcp-server.ts:2142`) through that chokepoint.
- [x] Make `assertSessionConsent` throw rather than return when the profile declares `consent_gate.required === true` but `profileState.consentGate` is unset (`http-transport.ts:4700`).
- [x] Refuse upstream dispatch when `required === true` and no reachable consent enforcer exists. `MCPServerManager.createServer` wires `setGetUpstreamClient` unconditionally (`mcp-server-manager.ts:80`), including when constructed without an `httpTransport`, which is a supported construction.
- [x] Add the `authType === 'oauth'` requirement to the consent lookup. A one-line guard in `consent-gate.ts` plus a test closes this; introduce a narrow `VerifiedOidcPrincipal` type only if it earns its keep, since the `authType` union at `inbound-auth-principal.ts:2` has many construction sites.
- [x] Normalize the issuer inside `ConsentGate.assertConsent()` before the store lookup, using the existing `normalizeIssuer` from `src/auth/issuer.ts`. Do not write a second helper.
- [x] ~~Apply `normalizeIssuer` at the one remaining raw comparison.~~ **Stale premise, no change needed.** The envelope-recovery comparison (now `http-transport.ts:3574`) compares two already-canonical values: the provider normalizes its issuer in the constructor (`oauth-provider.ts:177-180`) and `decryptTokenPayload` normalizes `iss` before returning (`token-envelope.ts:182`).
- [x] Pin the subject claim source in one place. The OIDC verifier prefers `oid` over `sub` (`oidc-identity-verifier.ts:61`) while `enterprise-auth-provider.ts:148-150` uses `sub`; document why the chosen stable identifier is used for evidence. Documented in `docs/OAUTH.md` (subject taken from `oid` when present, otherwise `sub`) and `docs/PROFILE-GUIDE.md`.
- [x] Implement D6/R3: on a consent miss, return 401 with the consent URL in `WWW-Authenticate` and invalidate the session/token once per subject per `rules_version`; later misses return the typed error without invalidating.
- [x] Implement D8 (moved here from section 8): `azp`/multi-audience validation in `oidc-identity-verifier.ts:52-69`, with tests for multi-`aud` without `azp`, with wrong `azp`, and with correct `azp`.
- [x] Tests: `token` and `enterprise` principals with matching subject and issuer are rejected; issuer trailing-slash equivalence across `consentEvidenceKey`, both store implementations, and `assertSessionConsent`; `tools/list` on a consent-gated profile with no evidence is rejected before any upstream connection; a `required: true` profile with no enforcer refuses dispatch.
- [x] Assert the specific typed error and a positive control in each negative test. `consent-gate.test.ts:111,128,131,151` currently use `toBeInstanceOf(ConsentRequiredError)`, and since `assertConsent` has one throw site that assertion cannot distinguish a correct rejection from a key-shape regression that rejects everything.

## 2. Repair Direct-Grant Refresh Continuity

Session refresh after encrypted recovery is done. Only the direct token-endpoint grant remains. Split into four checkboxes because the single-line framing hid multi-day work across `oauth-provider.ts` (1397 lines), the recovery path, and divergent consent/non-consent behavior.

- [x] Build the refresh envelope (D1), shipped with the `mcp4.r1.` prefix and a `pid + ":refresh"` AAD so it cannot be presented as an access-token envelope with the existing `deriveTokenKey`/`encryptTokenPayload` helpers and return it as `refresh_token` wherever the access-token envelope is already issued (`http-transport.ts:4465-4471,2236-2240`).
- [x] Wire decryption into the direct `refresh_token` grant path (`http-transport.ts:2233`) and pass the recovered identity as `rehydratedIdentity`; reject a non-envelope refresh token with `invalid_grant` when `consent_gate.required`.
- [x] Make `consent_gate.required === true` without `MCP4_OAUTH_KEY` a hard startup failure, next to the D2 evidence-path check. Today it is only a warning (`http-transport.ts:219-224`), which would make the D1 envelope silently unavailable.
- [x] Confirm the non-consent `clientId` fallback policy is unchanged and still covered by `http-transport.test.ts:4248`.
- [x] Test: fresh provider with an empty identity map, `exchangeRefreshToken` with no supplied identity, then assert `getIdentityForAccessToken` is `undefined` and that the consent-gated path writes no inbound principal for that token.
- [x] Test: restart simulation - new transport instance with the same `MCP4_OAUTH_KEY`, direct grant with a `mcp4.r1.*` refresh token, assert the minted access token carries the original `sub`/`iss`/`tid`; and the same grant with a raw refresh token on a consent-gated profile returns `invalid_grant`.

## 3. Consent Lifecycle and Record Shape

The evidence binding itself is done. What is missing is everything about the life of a grant after it is written. Land these together with any other `ConsentEvidence` change so the JSONL format breaks once, not twice.

- [x] Implement D3: TTL or max-age, and a revocation record type with a monotonic `rules_version` guard so a v2 to v1 rollback does not reactivate v1 grants. The operator path (no CLI or endpoint exists yet, so revocation means appending a record to the evidence file) is documented in `docs/HTTP-TRANSPORT.md` and locked in by `src/auth/consent-revocation-procedure.test.ts`.
- [x] Implement D4: `rules_hash` alongside `rules_version` if chosen.
- [x] Implement D5 if it changes the record shape.
- [x] Document the JSONL compatibility policy. Legacy pre-issuer records are already rejected by `parseLine` (`consent-evidence-store.ts:213-240`, test at `consent-evidence-store.test.ts:219`), so this shipped in `9843e7b` and is a documentation item, not code. Documented in `docs/HTTP-TRANSPORT.md` under "Evidence record format and compatibility": records from an earlier shape are ignored rather than trusted, so a format change is a re-consent event.
- [x] Update `TODO.md:35`, which still specifies the future backend key as "subject + profile + rules version", the pre-issuer shape.

## 4. File Evidence Store Hardening

- [x] Create the evidence directory `0700` and the file `0600`, and `chmodSync` an existing file before reading or appending. `mkdirSync`/`appendFileSync` `mode` options apply only on creation, so the upgrade path needs an explicit chmod.
- [x] Implement D2's production guard in `createConsentEvidenceStore`. The factory currently takes only a logger; it needs the consent requirement passed in.
- [x] Add a max-size cap with `ConsentEvidenceStoreError` and document a compaction or rotation procedure. `has()` re-reads and reparses the whole file on every mtime change, per tool call.
- [x] Fix or delete the cross-replica claim in the `FileConsentEvidenceStore` docstring. As written it is unsound: `refreshMtime()` runs `statSync` after the append and stores the result as `lastLoadedMtimeMs` without reading, so a peer append landing between our append and our stat is permanently missed. Cheapest correct fix is deleting the claim; the sound fix compares `(mtimeMs, size)` and never advances the watermark from a stat that did not accompany a read.
- [x] Reuse `ConsentEvidenceStoreError` (`src/core/errors.ts:197`). Do not add a new error type; it already exists and is thrown at `consent-evidence-store.ts:139,171,183`.
- [x] Test: permissive-umask directory and file modes, plus the tighten-an-existing-`0644`-file case. Put this in its own file with `describe.sequential` and `beforeEach`/`afterEach` umask save-restore, guarded by `it.skipIf(process.platform === 'win32')`. `process.umask()` is process-global and will otherwise contaminate parallel vitest workers.
- [x] Test: the four D2 factory cases (production plus required, not production, not required, path set).
- [x] If the persist path becomes async, strengthen `consent-evidence-store.test.ts:175`. Done: the persist path is now `fs/promises`, and the suite covers 10 concurrent identical grants collapsing to one line plus interleaved grants and revocations producing three distinct lines. Note the residual limit: those tests prove serialization and idempotency, not FIFO ordering. If ordering ever becomes load-bearing, it needs its own test.

## 5. Softeria Boundary: Validate What Shipped

The allow-list exists and is exact. It was never validated against a real catalog, and the documented validation procedure does not work.

- [x] **5.1 Correct the catalog procedure.** `--list-permissions` emits `permissions` / `toolPermissions` / `effectivePermissions` / `disabledTools` / `missingAllowedScopesForTools` and no tool names; the docs also pair it with `--http 3000`, which prints and exits without serving. The procedure that works, verified locally with no tenant, credentials, or browser: start the pinned server with `--read-only --org-mode --allow-unauthenticated-discovery --http 127.0.0.1:<port>`, `initialize`, then `tools/list`. That returns 163 tool names, and all 23 allow-list entries are present.
- [x] Fix the procedure in `docs/PROFILE-GUIDE.md:745-757`, `README.md:257`, and `env.example:86` together.
- [x] Commit the catalog as a fixture and add a test asserting `allow` is a subset of the fixture. This converts an unfalsifiable review item into a CI check.
- [x] Pin an upstream version the deployment can assert. Repo side done: the fixture pins upstream 0.136.0 with capture metadata and CI checks the allow-list against it. The deployment-side image/version pin is out of this repo and tracked in AIPP-520. The profile currently pins nothing (`transport.url` is a bare URL), so "the pinned Softeria server version" has no referent. If no pin is possible, state plainly that the allow-list is unverified defense in depth.
- [x] **5.2 Reclassify the allow-list by capability escape, not by mutation.** `get-download-url` is on the read-only list and returns an out-of-band, gateway-unmediated URL: the agent obtains it once under consent and can then fetch bytes indefinitely outside the gate, outside the allow-list, and outside any audit. `list-drive-item-permissions` exposes who-can-see-what. Decided: `get-download-url` removed from the allow-list (env override cannot re-add it; tests assert both), `list-drive-item-permissions` stays as a read-only reader with a mutating near-miss test. Gateway-mediated download proxy is `TODO.md` item 19; the scope decision is YouTrack AIPP-557.
- [x] **5.3 Make environment override mistakes loud.** This is config safety, not a trust boundary: `SOFTERIA_UPSTREAM_MCP` is set by the administrator, who already controls `profile.json` and the deployment and can weaken the policy directly if they choose. The goal is that an accidental, copied, or stale override fails at load with a typed error instead of silently taking effect. The existing `tools.allow`/`tools.deny` broadening guard (`upstream-mcp-config.ts:99-133`) already applies exactly this reasoning; extend it rather than inventing a second mechanism.
- [x] Extend that guard to reject an override that sets `html_description_policy` or `tool_description_length_policy` to `allow`. Omission hardens rather than weakens, because `mcp-server.ts:2179` defaults both to `drop`, which is stricter than Softeria's static `strip`/`truncate`. Reject only the explicit downgrade.
- [x] Decide whether an overridden `transport.url` must match a static allowed-origin declared in the profile. **Decided: no check.** An off-origin override is a legitimate deployment case (staging, an egress proxy), so rejecting it would break valid setups. Instead `describeEffectiveUpstreamOrigin` reports the effective endpoint and `MCPServer.logEffectiveUpstreamOrigin` logs it at profile load: info normally, warn when an environment override points off the static origin. Tests in `upstream-mcp-config.test.ts` and `mcp-server.test.ts`. Weigh it as a misconfiguration guard only. If a deliberate off-origin override is a legitimate deployment case (staging, a proxy), skip the check and instead log the effective upstream origin at startup so a wrong value is visible.
- [x] Tests: two unit tests in `upstream-mcp-config.test.ts`, which currently has no direct coverage of `validateEnvironmentToolPolicy` at all, each asserting the specific `ValidationError` message. Add an origin test only if the previous item decides in favor of the check.
- [x] ~~Update the schema-driven profile tests.~~ **Nothing to update.** Upstream MCP tools never appear in `tools[]`, so neither `profiles/softeria-sharepoint/profile.test.json` nor `tests/profiles/consent-gate/profile.test.json` references them; the upstream boundary is covered by `src/profile/softeria-profile.test.ts` instead. `profiles/softeria-sharepoint/profile.test.json` and `tests/profiles/consent-gate/profile.test.json` both exist and are the house pattern per `docs/PROFILE-TEST-GUIDE.md`; fall back to bespoke `*.test.ts` only for what the schema runner cannot express.
- [x] Add one permission-mutating near-miss to the policy tests, for example `update-drive-item-permissions`, since `list-drive-item-permissions` is on the allow-list.

## 6. Approval Interaction and Availability

- [x] Implement D7: `__Host-` consent cookie (HttpOnly, Secure, SameSite=Lax, Path=/) set at form render, matched on POST together with the one-time token and the fingerprint; cookie-less POST rejected. Record the contract in the threat model and user docs: the checkbox is an acknowledgement step, verified OIDC authentication is the identity proof, and neither proves human presence.
- [x] Rework `pendingConsentApprovals` so it cannot be starved: key by the request fingerprint (self-limiting and idempotent) with the D7 cookie id in the value, instead of a random token in a global FIFO. Roughly 20 source IPs at the current 10 req/min/IP limit sustain more than 1000 live 5-minute approvals and continuously evict legitimate ones, denying all tool access on the profile.
- [x] Apply the same reasoning to `refreshTokenIdentities` (`oauth-provider.ts:1233-1237`, cap 10000), where FIFO overflow silently drops a victim's identity binding and forces re-consent.
- [x] Give the approval failure page a retry link, and document the sticky-session or single-replica requirement next to the single-node evidence-store note. Behind a non-sticky load balancer the GET renders on one replica and the POST lands on another, producing a plain-text 400 with no recovery path.
- [x] Unify the two unsalted pseudonymization schemes (`observability-pseudonym.ts:7`, 32 hex, and the inline variant at `http-transport.ts:665`, 16 hex) into one keyed or salted helper. Both hash an Entra `oid` unsalted, so a log reader with directory access can rebuild the mapping. Done per R5 as the DRY half only: the inline hash is gone and `pseudonymizeSubject` is the single helper. Keying/salting stays out, since it needs a key source, rotation policy and stable output across restarts; the unsalted-linkability residual risk is recorded here rather than silently closed.
- [x] Tests: token expiry via `vi.useFakeTimers()` and not a real sleep; changed OAuth parameters (POST an altered `redirect_uri`, assert 400, which is the test that actually proves the request-binding claim); missing approval session; cross-session submission; and the chosen D7 policy.
- [x] Update `ConsentGateConfig` comments to one consistent term across types, runtime comments, tests, and docs, then run `npm run generate-schemas` and `git diff --exit-code profile-schema.json src/generated-schemas.ts`. `npm run check-schema-sync` does **not** compare descriptions: `overlayMetadata` in `scripts/profile-schema-sync-utils.js:120-131` copies `description` from the existing JSON file onto the generated schema. Live proof of undetected drift today: `src/types/profile.ts:65` says "upstream MCP tool calls are blocked", `profile-schema.json:1852` still says "tool calls are blocked", and the sync check reports success. Hand-edit lines 1852 and 1877.
- [x] If any field is added to `ConsentGateConfig` or `UpstreamMcpConfig`, regenerate schemas in the same commit. Zod strips unknown properties silently (`src/generated-schemas.ts:395`), so a missing generated field is a feature that is broken at runtime with no error.

## 7. Regression Test Backfill (single tracked item)

Roughly half of the original plan's "add a test" items already exist. Treat this as one work item: confirm each listed test still passes and covers the stated behavior, rather than fifty checkboxes an agent will try to re-implement.

Already covered, verify only: double initialization with the same envelope (`http-transport.test.ts:4721`); restart, recovery, refresh, second recovery (`:4795`, asserting the refreshed envelope decrypts to the original `sub`/`iss`/`tid` at `:4892-4898`); missing subject omits the principal (`:4270`); non-consent `clientId` fallback (`:4248`); identity across refresh rotation (`oauth-provider.test.ts:1575`); same subject under different issuers and tenants and a rules-version change (`consent-evidence-store.test.ts:88,100,213`, `consent-gate.test.ts:114,129,134`); key collision resistance (`consent-evidence-store.test.ts:47`); legacy-record rejection (`:219`); write-queue recovery (`:188`); concurrency, duplicates, file-disappears (`:175,166,202`); typed store error (`:237`); Softeria policy and override tests (`softeria-profile.test.ts:50,74,89,102,114`); tool policy on `tools/list` and cold-cache `tools/call` (`mcp-server.test.ts:5309,5329,5347`); validator cases (`consent-gate-validator.test.ts:75,93,101,113,127`); sessionless HTTP rejection (`http-transport.test.ts:1675`); approval token reuse (`:2783`).

- [x] Confirm the above still pass and still assert what they claim.
- [x] Add `expect(messageHandler).not.toHaveBeenCalled()` to the sessionless-HTTP test, so it proves rejection happens before the MCP handler rather than merely that a 400 was returned.
- [x] Add the plain `upstream_mcp: undefined` validator case. `consent-gate-validator.test.ts:93` covers only an unresolved env reference; both reach the same line but by different resolution paths.
- [x] Add an identity-survives-authorization-code-exchange test. `oauth-provider.test.ts:1101,1367` test the code path but not identity propagation.
- [x] Add a logging lock-in test asserting that issuer, tenant, subject, nonce, and audience are never logged raw. `consent-gate.ts:61-67` logs only booleans today; `auth-redaction.test.ts` covers tokens and keys only.
- [x] Add a stdio regression test once section 1 makes the stdio safety property an enforced control rather than a wiring accident. Covered by `src/mcp/mcp-server-manager.test.ts`: a consent-gated profile with no reachable enforcer (the stdio shape, no HTTP transport attached) refuses to dispatch and never acquires an upstream client.

## 8. Deferred, with Recorded Reasons

- [ ] `oid`-absent fallback to `sub` only. Multi-audience and `azp` moved to section 1 by D8; they are an identity-boundary control, not deferrable hardening.
- [ ] Transactional multi-replica evidence backend. Stays in `TODO.md`.
- [x] Browser-presence proof. No browser automation dependency exists in `package.json`. Cookie flags, CSRF token, and origin validation are testable at HTTP level with the existing harness; actual human presence is not. Record the residual risk in the threat model.
- [x] The misleading `TODO(phase-3/auth-gate)` comment at `mcp-server.ts:1584-1588`, which says the upstream proxy is wired unconditionally and must be guarded once the client-auth gate lands. Section 1 supersedes it; delete or rewrite it there rather than leaving it as separate work.

## 9. Documentation and Changelog

- [x] `docs/PROFILE-GUIDE.md`: upstream-only contract, corrected catalog procedure, issuer/tenant evidence binding, restart and re-consent behavior, file-store limitations.
- [x] `docs/HTTP-TRANSPORT.md`, `docs/OAUTH.md`, and `IMPLEMENTATION.md`: none of the three currently contains any consent content, yet sections 1, 2, and 6 are exactly transport, OAuth, and architecture material.
- [x] `README.md` and `env.example`: the Softeria override must not be copyable as a broader policy; the evidence-path variable and `MCP4_OAUTH_KEY` must be listed as required for consent-gated profiles; document that changing `rules_summary` forces re-consent (D4) and that the linked `education_resource` page is not pinned.
- [x] One consolidated operational note: single-node evidence store, sticky-session requirement for the approval flow, evidence file growth, and the separate multi-replica follow-up.
- [x] `CHANGELOG.md`: compressed one-line user-perspective entries. Call out that the evidence format change invalidates existing evidence files and consent must be re-granted; that break shipped in `9843e7b` and is not yet in the changelog.
- [x] Fix the em dashes that sit in this work's blast radius: `CHANGELOG.md:31`, `src/types/profile.ts:28`, `src/auth/consent-evidence-store.ts:97`, `src/auth/consent-gate.ts:40`, `src/profile/consent-gate-validator.ts:8`. Leave unrelated ones alone.
- [x] All new text in English with ASCII punctuation.

## 10. Validation Gates

Two gates in the previous revision of this plan were false-green and are corrected here.

- [x] `npm run validate -- profiles/softeria-sharepoint/profile.json` and `npm run validate -- tests/profiles/consent-gate/profile.json`. Bare `npm run validate` prints a usage banner and **exits 0**, so it proves nothing.
- [x] `npm run lint`. Never invoked by the previous revision despite the breadth of source changes.
- [x] `npm run generate-schemas` then `git diff --exit-code profile-schema.json src/generated-schemas.ts`, plus a hand-check of the `ConsentGateConfig` descriptions. `npm run check-schema-sync` verifies structure only.
- [x] `npm run typecheck` (already implied by `npm test`).
- [x] `npm test`. This is the gate. It runs `src/**` and `scripts/**` and excludes `tests/e2e/**` by design, because e2e needs broader network access; run `npm run test:e2e` separately only in an environment that has it, and do not treat its absence as a coverage gap here.
- [x] `npm test -- --coverage` then `node scripts/check-diff-coverage.js --base origin/main`. This is a **reporting step, not a gate**: every terminal path exits 0 (`:402`, `:417-427`) except a missing coverage file (`:239`), and `vitest.config.ts` sets no coverage thresholds. Read the miss list; a clean run does not mean adequate patch coverage.
- [x] Review the final diff for `clientId` fallback on consent-gated paths, missing issuer normalization, broad policy patterns, raw secret logging, and unrelated changes.
- [x] Re-run the audit scenarios and classify each finding as fixed, intentionally unsupported, or residual risk.
- [x] Record commands and results in this file or a sibling results file. No merge-request access is assumed.

## Definition of Done

- [x] Every upstream dispatch path, including `tools/list`, passes through one consent chokepoint, and a `required: true` profile cannot dispatch when no enforcer is reachable.
- [x] Only a verified profile-OAuth principal satisfies a required `identity_source=profile_oauth` lookup.
- [x] Issuer normalization is applied at lookup as well as at the guard, with one helper and one test matrix.
- [x] A consent record is bound to verified subject, canonical issuer, tenant, profile, and rules version, and its lifecycle (TTL, revocation, rules pinning) is decided and documented.
- [x] Authorization-code exchange, refresh, encrypted recovery, repeated initialization, and subsequent tool calls preserve the same verified identity, including the direct token-endpoint grant after restart.
- [x] Missing or inconsistent identity data on a consent-gated profile fails closed without using `clientId` as a human subject; non-consent behavior is unchanged.
- [x] Durable evidence files use restrictive permissions, are size-bounded, and production cannot silently select volatile storage.
- [x] A `consent_gate.required` profile refuses to start without an evidence path (D2) and without `MCP4_OAUTH_KEY` (D1), and a grant records the `rules_hash` of what was accepted (D4).
- [x] An environment override that downgrades tool or sanitization policy fails at load with a typed error rather than taking effect silently.
- [x] The Softeria allow-list is validated against a committed real catalog fixture in CI, and capability-escaping tools are an explicit decision.
- [x] The approval flow cannot be starved by unauthenticated requests, and its documentation matches what the implementation actually proves.
- [x] Corrected validation gates pass: profile validation with arguments, lint, `npm test`, schema regeneration with a clean diff.
- [x] Every checkbox is completed with evidence or explicitly left open with a recorded reason. Decision items (D1-D8, documentation) are complete when the decision is recorded here; all other items require a focused test.

## Appendix B: Implementation Results (2026-08-12)

Baseline before the work: `npm test` 168 files / 4149 tests, all passing.
After the work: `npm test` 169 files / 4242 tests, all passing; `npm run typecheck` clean.

| Section | Status | Evidence |
| --- | --- | --- |
| 1 Enforcement boundary | Done | Chokepoint is `MCPServerManager.buildUpstreamDispatch` wrapping `setGetUpstreamClient` (`mcp-server-manager.ts`); caller-side check removed from `mcp-server.ts`; `assertSessionConsent` throws `ConsentGateConfigurationError` when required-but-unwired; `authType`, canonical issuer and reason codes in `consent-gate.ts`. Tests: `mcp-server-manager.test.ts` (5, incl. no-enforcer refusal and ordering), `mcp-server.test.ts` (tools/list and tools/call denial with upstream never contacted), `consent-gate.test.ts` (parametrized over both stores). |
| 1 D8 `azp` | Done | `oidc-identity-verifier.ts` implements OIDC Core 3.1.3.7 rules 4-5; 5 tests. |
| 2 Refresh continuity | Done | `mcp4.r1.*` refresh envelope (`token-envelope.ts`), issued in both grants and consumed by `resolveRefreshGrant`; consent-gated profiles reject identity-less refresh tokens. Tests: 8 envelope tests + 5 transport tests. |
| 3 Lifecycle | Done | `rules_hash`, revocation records, rollback guard, optional `max_age_days`; policy evaluated in `ConsentGate`, store is persistence only. `TODO.md` item 1 updated to the new key shape and contract. |
| 4 File store hardening | Done | 0700/0600 with tightening of existing files, 32 MiB cap with typed error, `fs/promises`, incremental `(size, mtime)` tail reads, watermark never advanced from a stat without a read. Tests: `consent-evidence-store.test.ts`, `consent-evidence-store-permissions.test.ts`. |
| 4 D2 factory | Done | `createConsentEvidenceStore({evidencePath, consentRequired, logger})` fails closed; 5 tests. Startup also requires `MCP4_OAUTH_KEY` for consent-gated profiles. |
| 5 Softeria | Done | Catalog captured from upstream 0.136.0 (163 tools) as `profiles/softeria-sharepoint/upstream-catalog-0.136.0.fixture.json`; allow-list subset check and permission near-miss test in `softeria-profile.test.ts`; procedure corrected in guide, README and `env.example`. |
| 5.3 Override validation and origin visibility | Done | `validateEnvironmentOverride` rule table, called unconditionally; closes the hole where a static profile without a `tools` policy skipped all override validation. |
| 6 Approval and availability | Done | `__Host-mcp4_consent` cookie binding, fingerprint-keyed pending approvals, recoverable failure page, nearest-expiry eviction for `refreshTokenIdentities`. Tests include cookie-missing, cookie-mismatch, tampered `redirect_uri`, fake-timer expiry and a 50-render starvation check. |
| 7 Test backfill | Done | Added: plain `upstream_mcp: undefined` validator case, identity-survives-code-exchange test, consent logging lock-in test. |
| 9 Docs and changelog | Done | `CHANGELOG.md` updated (including the previously unrecorded evidence-format break). New consent sections in `docs/HTTP-TRANSPORT.md` (enforcement, denial payload, bounded re-consent 401, sticky-session requirement, one consolidated operational note), `docs/OAUTH.md` (acknowledgement hop, cookie binding, refresh envelope matrix), `IMPLEMENTATION.md`, `README.md`, `env.example`, `docs/PROFILE-GUIDE.md`. Em dashes checked: none in added lines. |
| 10 Gates | Done | `npm test` green; `npm run typecheck` clean; `npm run lint` produces the same pre-existing failures with and without this change (verified by stashing); `npm run validate` passes for both profiles with arguments; `npm run generate-schemas` is idempotent and `check-schema-sync` passes; patch coverage 91.8% statements. |

Deliberate deviations from the plan text:

- The `process.umask()` based permission test could not be used: vitest workers reject `process.umask()`. Wide modes are simulated by pre-creating the directory and file instead, which tests the same tightening path.
- The profile-test coverage gate now skips `*.fixture.json`. A content-based predicate was tried first but would have invalidated existing temp-fixture tests in that file.
- The re-consent invalidation deletes the session even if stream/token teardown throws, so a denial can never leave a usable session behind.

Second bug found and fixed while locking in the documented revocation runbook: once a subject was revoked, they could never consent again for the same `rules_version`. The index kept the earliest grant per key for audit stability and the store suppressed duplicate writes, so a fresh acceptance was neither written nor visible and `revokedAt >= grant.granted_at` stayed true forever. Reproduced by `src/auth/consent-revocation-procedure.test.ts` before the fix. The lookup now also returns `grantRenewedAt` (most recent acceptance for the key), policy evaluates revocation and max age against that, and the write path no longer suppresses a grant that supersedes a revocation. The audit record still reports the original `granted_at`, and the JSONL format is unchanged.

Bug found and fixed while documenting: `resolveConsentGateConfig` rebuilt `consent_gate` from an explicit field list that omitted `max_age_days`, and `ProfileLoader` writes that result back onto the profile, so the field never reached `ConsentGate` for any profile loaded from disk. Reproduced with a failing test first (`consent-gate-validator.test.ts`, "preserves the whole policy, including max_age_days"), then fixed by spreading the source config, so a future `ConsentGateConfig` field cannot be dropped the same way.

Still open:

- 5.2 capability decision: resolved for `get-download-url`. It was removed from the allow-list because its pre-authenticated Microsoft Graph URL streams bytes with no `Authorization` header, so blocking client access to the upstream server does not contain it. `download-bytes` is the mediated replacement; tests assert the absence and that an env override cannot re-add it. A gateway-mediated streaming proxy is a candidate in `TODO.md` item 19, and the scope decision behind it is tracked in YouTrack AIPP-557 (subtask of AIPP-432). `list-drive-item-permissions` stays: it is a read-only permission reader, and the mutating near-miss is covered by a test. Unverified follow-up recorded in AIPP-557: Graph thumbnail URLs from `list-drive-item-thumbnails` may be pre-authenticated in the same way.
- Section 8 deferred items are unchanged, except `azp`/multi-audience which moved into section 1 and shipped.
- Multi-replica evidence backend remains `TODO.md` item 1.

## Appendix A: Fixed Before `7e11551` - Do Not Re-Implement

Verified present in the working tree. Retain the regression tests and review gates; do not redo the fixes.

| Original finding | Fixed at | Evidence |
| --- | --- | --- |
| Recovery stored `clientId` as the inbound subject | `30a85d6` | `http-transport.ts:3559-3570`, guard at `:3561` |
| Refresh identity lost after restart (session refresh) | `e1b06d2` | `http-transport.ts:4903-4917,4934` |
| Evidence keyed only by subject, profile, rules version | `9843e7b` | `consent-evidence-store.ts:47-63` |
| Evidence key delimiter-collision risk | `9843e7b` | `JSON.stringify` five-tuple; test at `consent-evidence-store.test.ts:47` |
| One failed write permanently rejected the queue | `e1b06d2` | `consent-evidence-store.ts:115-121`; test at `:188` |
| Softeria broad substring globs | `e1b06d2` | Exact 23-name list, `profiles/softeria-sharepoint/profile.json:37-61` |
| Env override could broaden `tools.allow`/`tools.deny` | `e1b06d2` | `upstream-mcp-config.ts:99-133`; tests at `softeria-profile.test.ts:89,102` |
| Local-tool consent configurations not rejected | `e1b06d2` | `consent-gate-validator.ts:88-100` |
| Missing typed evidence-storage error | already present | `src/core/errors.ts:197` `ConsentEvidenceStoreError` |
| Issuer normalization missing at the OAuth provider boundary | never true | `oauth-provider.ts:32,177,1161`; `token-envelope.ts:241` |

Agent authored:
