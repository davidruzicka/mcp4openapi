---
status: diagnosed
trigger: "Diagnose root cause for UAT gap in Phase 01 (upstream-session-foundation): X-Upstream-Authorization multi-provider credential model is wrong for this architecture."
created: 2026-03-27T00:00:00Z
updated: 2026-03-27T00:00:00Z
---

## Current Focus

hypothesis: Planning assumed an aggregation server model (one instance serving N upstream providers, each identified by provider-name= key). Actual architecture is one-profile-per-upstream: the profile IS the upstream, so the client already sends a plain Authorization header targeting that single upstream.
test: N/A - architectural mismatch confirmed by reading all relevant files and confirming SessionData.upstreamCredentials is never populated anywhere in http-transport.ts
expecting: N/A
next_action: Deliver diagnosis to user

## Symptoms

expected: Upstream credential forwarding works with standard Authorization header passed through from client to the single upstream MCP server configured in the profile.
actual: Implementation built X-Upstream-Authorization multi-provider credential parsing (extractor + UpstreamCredentialStore + SessionData.upstreamCredentials field) that is never wired in http-transport.ts and is conceptually wrong for single-profile-per-upstream architecture.
errors: No runtime error - architectural mismatch caught in UAT planning review.
reproduction: N/A - design-level gap, not a runtime crash.
started: Phase 01 planning

## Eliminated

- hypothesis: UpstreamCredentialStore is wired but buggy
  evidence: grep confirms SessionData.upstreamCredentials is never written anywhere in http-transport.ts - the store is never populated at session init, so getOrConnect always receives a store with no tokens
  timestamp: 2026-03-27

- hypothesis: buildAuthHeaders is the wrong layer to fix
  evidence: buildAuthHeaders itself is correct plumbing - it reads from a credentials object and produces headers. The problem is upstream of it: the wrong credential model means it will never get a token in the single-profile architecture
  timestamp: 2026-03-27

## Evidence

- timestamp: 2026-03-27
  checked: src/upstream/upstream-credential-extractor.ts
  found: Parses X-Upstream-Authorization: provider-name=token,provider2=token2 - a custom multi-provider header format
  implication: Designed for aggregation server where one instance proxies N different upstream providers per request

- timestamp: 2026-03-27
  checked: src/upstream/upstream-credential-store.ts
  found: UpstreamCredentialStore is a Map<providerName, token> wrapper with setToken/getToken/clear. buildAuthHeaders reads from it using provider.name as key.
  implication: All store plumbing is correct but depends on X-Upstream-Authorization being parsed and populated - which never happens

- timestamp: 2026-03-27
  checked: src/types/http-transport.ts SessionData.upstreamCredentials
  found: Field exists as Map<string, string> with comment "(PROXY-02)" but is never written in http-transport.ts
  implication: The bridge between session init (where headers are available) and getOrConnect (where credentials are needed) is completely missing

- timestamp: 2026-03-27
  checked: src/upstream/upstream-connection-manager.ts getOrConnect signature
  found: Takes credentials: UpstreamCredentials - a named interface with getToken(providerName) and hasCredentials(providerName)
  implication: The credentials abstraction itself is sound; the wrong part is HOW the token gets into the credentials object

- timestamp: 2026-03-27
  checked: src/transport/http-transport.ts (grep for upstreamCredentials, extractUpstreamCredentials, UpstreamCredentialStore)
  found: Zero references to any of these in http-transport.ts. The extractor is completely unwired.
  implication: The entire X-Upstream-Authorization flow is dead code - nothing calls extractUpstreamCredentials, nothing populates UpstreamCredentialStore, nobody passes credentials into getOrConnect

- timestamp: 2026-03-27
  checked: Actual routing architecture
  found: Clients hit /profile/{profileId}/mcp with a plain Authorization: Bearer ${token}. The profile defines exactly one upstream MCP server. There is no provider-name disambiguation needed.
  implication: The correct credential source is session.authToken (already stored on SessionData from the inbound Authorization header), not a new X-Upstream-Authorization header

## Resolution

root_cause: Planning introduced an aggregation-server mental model where one mcp4openapi instance would multiplex N upstream providers and clients would identify which provider's token they were sending via X-Upstream-Authorization: provider-name=token. The real architecture is profile-per-upstream: each profile has exactly one upstream, and the client's standard Authorization header IS the upstream credential. The multi-provider credential machinery (extractor, UpstreamCredentialStore, SessionData.upstreamCredentials) is entirely dead code and architecturally wrong.

fix: |
  1. DELETE src/upstream/upstream-credential-extractor.ts and its test
  2. DELETE UpstreamCredentialStore class from upstream-credential-store.ts (keep buildAuthHeaders, but change its signature)
  3. DELETE SessionData.upstreamCredentials from src/types/http-transport.ts
  4. DELETE UpstreamCredentials interface from src/types/upstream-connection.ts
  5. Change getOrConnect signature: replace `credentials: UpstreamCredentials` with `authToken: string | undefined`
  6. Change buildAuthHeaders signature: replace `credentials: UpstreamCredentials` with `token: string | undefined`
  7. In createConnection, derive authToken from session.authToken (already present on SessionData) passed down from the tool-dispatch layer
  8. Update upstream-connection-manager.test.ts to pass a plain string token instead of a credentials object

verification: empty until verified
files_changed:
  - src/upstream/upstream-credential-extractor.ts (delete)
  - src/upstream/upstream-credential-extractor.test.ts (delete)
  - src/upstream/upstream-credential-store.ts (remove UpstreamCredentialStore class)
  - src/upstream/upstream-credential-store.test.ts (remove UpstreamCredentialStore tests)
  - src/types/upstream-connection.ts (remove UpstreamCredentials interface)
  - src/types/http-transport.ts (remove upstreamCredentials field from SessionData)
  - src/upstream/upstream-connection-manager.ts (change getOrConnect + createConnection signature)
  - src/upstream/upstream-connection-manager.test.ts (update tests)
