# MR 38 Consent Gate Remediation Plan

## Purpose

This plan converts the security and correctness audit of MR 38 into an implementation sequence. It is written for both the implementation agent and the reviewer who will verify that the fixes address the actual failure modes rather than only changing local symptoms.

The audited revision is `30a85d6e8bc64d69297f26fe955979e260ec0650` on `origin/aipp-432-ms365-consent-gate`. The local checkout may contain newer or unrelated work; implementation must be based on the current code and must not silently revert unrelated changes.

MR 38 adds an OIDC-backed human consent gate for sensitive upstream MCP profiles. The intended invariant is:

> A tool call on a required-consent profile is allowed only when the request is bound to a verified OIDC human identity and that identity has accepted the current rules version for the same profile and issuer/tenant context.

The audit found strong OIDC primitives and a deliberate fail-closed change, but also found lifecycle inconsistencies and policy gaps that can cause outages or weaken the advertised read-only boundary:

- The encrypted-token recovery path reconstructs the correct OIDC principal, then stores a different principal in the inbound token store.
- Refresh identity state is process-local, so a recovered session can lose identity when it refreshes after a restart.
- Consent evidence is keyed only by subject, profile, and rules version; issuer and tenant are absent.
- A single failed file-store write permanently rejects the subsequent write queue.
- The Softeria profile uses broad substring globs for a profile described as read-only, and the environment override can replace the complete upstream object.
- The type-level consent contract says "any tool call", while runtime enforcement and documentation implement upstream-only enforcement. Local-tool consent configurations are not rejected.
- Issuer normalization is performed in the OIDC verifier but not consistently at the OAuth provider boundary.

The audit did not confirm a direct stdio bypass or a sessionless HTTP bypass. Stdio currently has no wired upstream client, and non-initialize HTTP requests require an MCP session before reaching the MCP handler. These facts must remain covered by regression tests.

## Scope and Non-Goals

This plan covers the consent-gate feature and the Softeria profile boundary. It does not redesign unrelated OAuth flows, enterprise authorization, or the general upstream transport.

The recommended scope decision is **upstream-only consent in this iteration**. Required consent should be rejected for local-tool-only profiles instead of implying protection that the runtime does not provide. Supporting consent for local OpenAPI tools would be a separate design change requiring a common authorization boundary.

The implementation must preserve these existing security properties:

- OIDC issuer, audience, signature, expiry, nonce, algorithm, discovery, JWKS-origin, and SSRF checks remain enforced.
- A missing verified subject must fail closed and must never fall back to OAuth `clientId`.
- Approval tokens remain one-time, short-lived, and bound to the complete OAuth request.
- A rules-version change invalidates prior consent.
- OAuth access and refresh tokens remain secret and must not appear in logs or error messages.
- The durable multi-replica evidence backend remains a separate operational follow-up unless this work explicitly implements it.

## Implementation Order

The work is ordered so that identity semantics are defined before storage and transport fixes depend on them. Do not mark a checkbox complete until its focused tests pass.

## 0. Baseline and Working Contract

- [ ] Confirm the implementation branch and reviewed behavior against the current repository state; preserve unrelated worktree changes.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run validate` before source changes, recording any pre-existing failures separately from regressions.
- [ ] Re-read the canonical profile and error contracts in `src/types/profile.ts`, `src/core/errors.ts`, `docs/PROFILE-GUIDE.md`, and `AGENTS.md` before changing public types or validation.
- [ ] Record the chosen upstream-only scope decision in the implementation issue or review notes before changing the validator and documentation.

## 1. Establish One Canonical Verified Identity

The current implementation carries identity through `OidcIdentity`, `AuthorizedPrincipal`, OAuth token metadata, session state, encrypted envelopes, and consent evidence. The fix must make the fields and their meaning explicit rather than reconstructing partial objects at each boundary.

- [ ] Define or reuse one typed identity shape containing `subject`, canonical `issuer`, and optional `tenantId`, with explicit semantics for each field.
- [ ] Define one issuer-normalization helper at the configuration boundary and use the same canonical value for OAuth provider state, OIDC verification, discovery comparison, principals, envelopes, evidence, and runtime consent checks.
- [ ] Preserve issuer path components and apply only the normalization policy intended by the existing verifier; add tests for the configured issuer with and without a trailing slash.
- [ ] Update OAuth authorization-code, access-token, and refresh-token state to carry the canonical identity without substituting `clientId` for `subject`.
- [ ] Update inbound principals and sessions to retain the same identity object or equivalent fields, including issuer and tenant where available.
- [ ] Add unit tests proving that a missing verified subject produces no consent-capable principal and cannot bind evidence to `clientId`.
- [ ] Add unit tests proving that identity fields survive authorization-code exchange and refresh-token rotation.

## 2. Repair Encrypted-Token Recovery and Refresh Continuity

The recovery code already reconstructs `resolvedClientPrincipal` from `sub`, `iss`, and `tid`, but later writes `clientId` as the inbound subject. The corrected principal must be the single source for both session creation and token-store rehydration.

- [ ] Change encrypted-token recovery so the inbound token store receives the recovered verified principal, including `subject`, `issuer`, `tenantId`, `clientId`, scopes, and expiry.
- [ ] Ensure the recovery path does not create an inbound principal at all when the envelope has no verified subject; the consent gate must continue to fail closed.
- [ ] Ensure issuer validation happens before a recovered principal is stored or used, and keep profile issuer binding explicit.
- [ ] Preserve the session identity when a recovered session refreshes its access token after a process restart.
- [ ] Choose and document one refresh implementation: either pass the session identity explicitly into token storage, or rehydrate the OAuth provider refresh-token identity map from the verified envelope before exchange. Do not rely only on process-local refresh-token state.
- [ ] Ensure a newly issued encrypted envelope after refresh contains the verified `sub`, canonical `iss`, and `tid` values.
- [ ] Add a regression test that initializes twice with the same valid encrypted envelope and verifies that both sessions use the same verified principal and can pass the same consent lookup.
- [ ] Add a regression test for restart -> recovered session -> token refresh -> newly issued envelope -> second restart recovery.
- [ ] Add a regression test that an envelope with a missing or mismatched issuer cannot create a consent-capable session.

## 3. Bind Consent Evidence to Issuer and Tenant

Consent is an audit decision, not only a boolean cache entry. The evidence record and lookup key must identify the same security domain as the verified principal.

- [ ] Extend `ConsentEvidence` and `ConsentEvidenceStore` so evidence includes canonical issuer and an explicit tenant value or absence marker.
- [ ] Change `has()` and the evidence key builder to use the complete identity context rather than only `sub`, profile ID, and rules version.
- [ ] Use an unambiguous structured key encoding, such as a serialized tuple or equivalent collision-resistant representation; do not rely on raw delimiter concatenation for attacker-controlled fields.
- [ ] Update the consent-recording callback to persist the verified issuer and tenant from the OIDC identity.
- [ ] Update `ConsentGate.assertConsent()` to perform lookup using the complete verified principal and to reject missing issuer data for a required profile.
- [ ] Decide and document the JSONL compatibility policy for existing records that lack issuer or tenant fields. The secure default is that legacy records do not satisfy a new lookup; provide an explicit migration path if backward compatibility is required.
- [ ] Add tests proving that the same subject under different issuers does not share consent.
- [ ] Add tests proving that the same subject and issuer under different tenants does not share consent.
- [ ] Add tests proving that a rules-version change still requires new approval after the key shape changes.
- [ ] Update evidence-store fixtures and comments so they describe the complete identity binding and not the old three-part key.

## 4. Make File Evidence Writes Recoverable

`FileConsentEvidenceStore.writeQueue` must serialize writes without turning one filesystem error into a permanent process-wide consent outage.

- [ ] Refactor file-store queueing so each failed operation rejects its caller but the queue is reset for subsequent operations.
- [ ] Ensure `has()` waits for pending writes without inheriting an unrecoverable rejected queue from an earlier failed write.
- [ ] Preserve append-only behavior, idempotent first-grant semantics, file permissions, reload-on-mtime behavior, and fail-closed handling of malformed evidence.
- [ ] Add a typed evidence-storage error if the existing error taxonomy does not provide one; redact file paths or sensitive record contents where required by the logging policy.
- [ ] Add a test that forces one write to fail, verifies the failure is returned, then makes a later write succeed and verifies that `has()` observes it.
- [ ] Add tests for concurrent records, duplicate records, malformed legacy records, and a file that disappears between reload and append.
- [ ] Keep the single-node limitation explicit; do not claim transactional multi-replica guarantees for this file backend.

## 5. Enforce an Explicit Softeria Read-Only Policy

The profile description promises read-only SharePoint/drive access, but `*sharepoint*`, `*site*`, and `*drive*` match arbitrary valid tool names containing those substrings. The safety boundary must be based on the actual pinned tool catalog, not naming intuition.

- [ ] Obtain the effective tool catalog for the pinned Softeria server version using the documented `--list-permissions` or equivalent deployment verification procedure.
- [ ] Classify the catalog into permitted read operations and denied mutation, sharing, permission, upload, delete, update, and administrative operations.
- [ ] Replace broad substring globs in `profiles/softeria-sharepoint/profile.json` with an explicit exact allow-list of verified read-only tool names, adding a deny-list for known dangerous names where defense in depth is useful.
- [ ] Apply the same restrictive policy to `tests/profiles/consent-gate/profile.json` and any environment examples or fixtures that model the Softeria profile.
- [ ] Make `SOFTERIA_UPSTREAM_MCP` unable to broaden the consent-gated profile policy. Prefer separating connection overrides from policy overrides; if policy overrides remain supported, reject any effective policy that is broader than the static profile policy.
- [ ] Define whether an environment override with a missing, broader, or incompatible `tools` policy is rejected at profile load or deployment startup; return a typed configuration error rather than silently weakening the policy.
- [ ] Verify that the same effective policy is applied to `tools/list` and `tools/call`, including the cold-cache `tools/call` path.
- [ ] Add policy tests for `*_delete`, `*_update`, permission-changing names, and names containing `site`, `drive`, or `sharepoint`.
- [ ] Add profile-loader tests proving that endpoint/auth overrides do not remove the static read-only policy.
- [ ] Add an integration-level test proving that a mutating-looking upstream tool is rejected even when it passes the generic valid-name sanitizer.
- [ ] Update the Softeria profile description and operational documentation to state that the gateway allow-list is defense in depth and that the upstream server must also be pinned and started in read-only mode.

## 6. Make the Consent Contract Explicitly Upstream-Only

The implementation and documentation describe consent as an upstream MCP feature, while the type comments imply that every tool call is gated. The loader should reject unsupported configurations rather than allow a profile that appears protected but is not.

- [ ] Update `ConsentGateConfig` and related comments to state whether the current feature gates upstream MCP dispatch only; use one consistent term across types, runtime comments, tests, and docs.
- [ ] After effective upstream configuration is resolved, reject a required consent gate when no `upstream_mcp` is present.
- [ ] Reject required consent together with non-empty local `tools[]`, or implement a common authorization hook for local and upstream tools before choosing this alternative.
- [ ] Ensure `upstream_mcp_from_env` is included in the invariant check after resolution, so an env-backed upstream cannot bypass validation.
- [ ] Add validator tests for required consent without OAuth, without `openid`, without upstream MCP, with local tools, and with a valid upstream-only profile.
- [ ] Add a profile-loader test for the effective environment-backed upstream configuration.
- [ ] Keep the existing stdio behavior explicit: required upstream consent profiles are unavailable over stdio until a browser-capable flow and upstream client are intentionally implemented.
- [ ] Add a regression test that a non-initialize HTTP tool call without `Mcp-Session-Id` is rejected before the MCP handler and before consent/upstream dispatch.

## 7. Close OIDC Edge-Case Decisions

These items are lower priority than identity continuity, but they prevent ambiguous future behavior at the OIDC boundary.

- [ ] Add a test matrix for issuer configuration normalization, discovery issuer equality, runtime principal issuer equality, and consent lookup equality.
- [ ] Decide whether the configured provider permits multi-audience ID tokens. If yes, validate `azp` according to the provider contract; if no, document and test the single-audience assumption.
- [ ] Add tests for a token with multiple audiences, an incorrect `azp`, and a valid `azp` if multi-audience support is retained.
- [ ] Confirm that `oid` versus `sub` selection is intentional for the configured provider and document why the chosen stable identifier is used for consent evidence.
- [ ] Verify that issuer, tenant, subject, nonce, and audience values are never logged in raw form where the existing redaction policy requires hashing or omission.

## 8. Documentation, Changelog, and Operational Follow-Up

- [ ] Update `docs/PROFILE-GUIDE.md` to describe the final upstream-only contract, exact policy requirements, issuer/tenant evidence binding, restart behavior, and file-store failure limitations.
- [ ] Update `README.md` and `env.example` so the Softeria environment override cannot be copied as a broader policy than the static profile.
- [ ] Document the required pinned upstream server version and the procedure for verifying its effective read-only tool catalog.
- [ ] Update `CHANGELOG.md` with concise user-facing entries for the corrected consent identity binding, read-only policy, and recovery behavior.
- [ ] Review `TODO.md`: retain the transactional multi-replica backend as outstanding unless implemented, and remove only items that this work actually completes.
- [ ] Add an operational note that `MCP4_CONSENT_EVIDENCE_PATH` is single-node/file-backed and that multi-replica production requires the separate transactional backend.
- [ ] Ensure all new comments, documentation, changelog entries, and plan updates use English and ASCII punctuation in accordance with repository rules.

## 9. Validation and Review Gates

- [ ] Run focused unit tests for OIDC verification, issuer normalization, consent gate lookup, evidence-store keying, and file-store queue recovery.
- [ ] Run focused transport tests for encrypted recovery, repeated initialization, refresh continuity, consent rejection, and sessionless HTTP requests.
- [ ] Run focused upstream policy and Softeria profile tests, including environment override cases.
- [ ] Run `npm run generate-schemas` if profile types or generated schema inputs changed.
- [ ] Run `npm run check-schema-sync` after schema generation and resolve all drift.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run validate`.
- [ ] Run the complete `npm test` suite.
- [ ] Run coverage and the repository diff-coverage check when source behavior changes materially: `npm test -- --coverage` followed by `node scripts/check-diff-coverage.js --base origin/main`.
- [ ] Review the final diff for accidental fallback to `clientId`, missing issuer/tenant propagation, broad policy patterns, raw secret logging, and unrelated changes.
- [ ] Re-run the audit scenarios against the implemented code and classify each original finding as fixed, intentionally unsupported, or residual risk.
- [ ] Record test commands and results in the implementation issue or merge request before marking the plan complete.

## Definition of Done

- [ ] A consent record is bound to verified subject, canonical issuer, tenant context, profile, and rules version.
- [ ] Authorization-code exchange, refresh, encrypted recovery, repeated initialization, and subsequent tool calls preserve the same verified identity.
- [ ] Missing or inconsistent identity data fails closed without using `clientId` as a human subject.
- [ ] One file-store failure does not permanently disable later evidence writes.
- [ ] The Softeria gateway policy is an explicit verified read-only allow-list and cannot be broadened by its deployment override.
- [ ] Required consent cannot be configured for an unprotected local-tool-only profile.
- [ ] Issuer normalization has one implementation and one test contract.
- [ ] The documented single-node evidence limitation and separate multi-replica follow-up remain accurate.
- [ ] Focused tests, schema checks where applicable, typecheck, profile validation, and the full test suite pass.
- [ ] Every checkbox in this plan is either completed with evidence or explicitly left open with a recorded reason; no checkbox is marked complete based only on code inspection.
