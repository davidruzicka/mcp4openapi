---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Ready to plan
stopped_at: Completed 03.2-03-PLAN.md
last_updated: "2026-05-03T22:56:32.129Z"
progress:
  total_phases: 7
  completed_phases: 5
  total_plans: 17
  completed_plans: 17
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** A security boundary between internal AI clients and all upstream MCP servers - one place to authenticate, authorize, audit, and proxy every tool call.
**Current focus:** Phase 03.2 — profile-env-var-description

## Current Position

Phase: 04
Plan: Not started

## Performance Metrics

**Velocity:**

- Total plans completed: 0
- Average duration: -
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
| Phase 01 P01 | 8min | 3 tasks | 10 files |
| Phase 01 P03 | 2min | 2 tasks | 3 files |
| Phase 01 P02 | 4min | 2 tasks | 3 files |
| Phase 01 P04 | 5min | 2 tasks | 8 files |
| Phase 01 P05 | 7 | 3 tasks | 12 files |
| Phase 02-tool-discovery-and-call-proxy P01 | 4min | 3 tasks | 6 files |
| Phase 02-tool-discovery-and-call-proxy P02 | 8min | 2 tasks | 3 files |
| Phase 02-tool-discovery-and-call-proxy P03 | 12min | 2 tasks | 5 files |
| Phase 03-client-authentication-gate P01 | 5min | 3 tasks | 9 files |
| Phase 03-client-authentication-gate P02 | 6min | 3 tasks | 5 files |
| Phase 03-client-authentication-gate P03 | 10min | 3 tasks | 6 files |
| Phase 03.1-remove-multi-upstream-mcp-support P01 | 5 | 3 tasks | 8 files |
| Phase 03.1-remove-multi-upstream-mcp-support P02 | 8min | 3 tasks | 6 files |
| Phase 03.2-profile-env-var-description P01 | 3min | 2 tasks | 2 files |
| Phase 03.2-profile-env-var-description P02 | 4min | 3 tasks | 4 files |
| Phase 03.2-profile-env-var-description P03 | 5min | 2 tasks | 2 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: 5-phase structure (revised 2026-04-22): Phase 3=API keys only, Phase 4=OIDC JWT, Phase 5=Observability; original 4-phase had JWT+API keys bundled in Phase 3
- [Roadmap]: Profile-per-upstream model confirmed - no aggregation across providers in a single session
- [Phase 01]: X-Upstream-Authorization HTTP header for credential delivery (resolves RESEARCH.md Open Question #1)
- [Phase 01]: Data-driven auth header builders via lookup table; per-provider token Map in SessionData
- [Phase 01 P03]: Ping timeout delegated to caller via pingFn parameter - keeps heartbeat manager simple and testable
- [Phase 01 P03]: Timer map keyed by string (sessionId:providerName) for flexible multi-connection support
- [Phase 01]: Factory injection (clientFactory, transportFactory) for testability in UpstreamConnectionManager
- [Phase 01]: Promise-based pending connection dedup via Map key sessionId:providerName
- [Phase 01]: Setter method setUpstreamConnectionManager in HttpTransport for clean optional wiring
- [Phase 01]: Profile-per-upstream model confirmed: X-Upstream-Authorization and UpstreamCredentials were wrong-model dead code; buildAuthHeaders and getOrConnect now accept token: string | undefined directly
- [Phase 01]: Bearer suffix preserves original case of Bearer keyword; JWT regex fires first so JWT tokens in error messages stay as [REDACTED_JWT]
- [Phase 01]: HTTP 502 for SSRF/timeout/connection errors during upstream validation; 401 only for explicit auth rejection (UpstreamAuthError)
- [Phase 02]: Truncate dropped tool names to 100 chars in SanitizationResult.dropped and logger.warn to prevent log injection of upstream tool names
- [Phase 02]: NotificationQueue TTL eviction uses Date.now() not entry.timestamp - correct under clock skew
- [Phase 02]: D-02 mutual-exclusivity check placed after resolveUpstreamMcpConfig so env-sourced config is resolved before check fires
- [Phase 02]: Callback injection (setGetUpstreamClient) rather than direct UpstreamConnectionManager import avoids circular dependency and keeps module boundary clean
- [Phase 02]: Provider name in error.data.providerName only - not in client-facing message string - prevents infrastructure name leakage at security boundary
- [Phase 02-tool-discovery-and-call-proxy]: NOTIFICATION_DISPATCH is private static readonly - constant data shared across instances; hasActiveStreamFn callback injected from HttpTransport avoids circular dependency; sendToClient fixed to write to SSE response in real-time
- [Phase 03-client-authentication-gate]: Phase 3 client auth gate ships ClientAuthGateConfig without jwt? field; Phase 4 extends same interface (no breaking change). ApiKeyStoreConfig union ships only 'inline'; 'sasanka' rejected with explicit 'not supported' error so misconfigured profiles fail fast. key_from_env existence is validated at load time — prevents silent runtime rejection of all keys when env var typo is present.
- [Phase 03-client-authentication-gate]: Mutual exclusion limited to OAuth interceptors: bearer/custom-header/query interceptors target upstream APIs and are allowed alongside client_auth_gate; only OAuth on inbound creates ambiguous identity flow. Default mode='required' (closed by default); required without api_keys is rejected so an unconfigured gate fails fast at startup.
- [Phase 03-client-authentication-gate]: Per-instance random HMAC secret used purely as a length-normalization device (not an authenticator); HMAC-SHA256 always emits 32 bytes so timingSafeEqual is invoked on equal-length buffers regardless of raw key lengths
- [Phase 03-client-authentication-gate]: createApiKeyStore uses direct if-branch on config.type (not registry table) so Phase 4's union widening with 'sasanka' triggers a TS exhaustiveness error at the extension site — type-system-enforced safety a Record<string,Creator> registry cannot provide. Logger param retained on factory for Phase 4 SasankaApiKeyStore additivity.
- [Phase 03-client-authentication-gate]: Test ESM-namespace mocking pattern adopted: vi.mock + vi.hoisted wrapper that delegates to vi.importActual is the canonical pattern in this codebase for asserting on calls into Node built-ins (node:crypto etc.) since vi.spyOn fails on ESM namespace exports with 'Cannot redefine property'
- [Phase 03-client-authentication-gate]: [Phase 03-03]: Gate placement after enterprise auth, before authConfigs token-required guard, with !gate bypass prefix on the legacy guard so mode='optional' can allow anonymous sessions on profiles with authConfigs configured
- [Phase 03-client-authentication-gate]: [Phase 03-03]: ALL client auth gate exceptions map to HTTP 401 (not 500); warn log records errorType to distinguish ClientAuthGateError from unknown errors without leaking validator internals to clients
- [Phase 03-client-authentication-gate]: [Phase 03-03]: Phase 4 deferral pinned by source-text guard test (no jose/jwks-cache imports or runtime calls); test will start failing intentionally when Phase 4 lands the JWT path, signaling the deferral guard has been lifted
- [Phase 03-client-authentication-gate]: [Phase 03-03]: ClientAuthGate constructed once per profile in getProfileState() (not per-request) so the underlying InlineApiKeyStore HMAC secret persists for constant-time comparison; gate lifecycle ties to ProfileRuntimeState
- [Phase 03.1-remove-multi-upstream-mcp-support]: ZodError (not ValidationError) thrown when upstream_mcp: [...] array is present in YAML/JSON profile - Zod schema catches it before loader runtime validation runs
- [Phase 03.1-remove-multi-upstream-mcp-support]: validateUpstreamProvider path changed to 'upstream_mcp' (no [N] index) - all error paths are now upstream_mcp.transport.url, upstream_mcp.auth.header_name, etc.
- [Phase 03.1-remove-multi-upstream-mcp-support]: hasUpstreamMcpFlag lives in upstream-mcp-config.ts (semantic owner of all upstream_mcp logic) not profile-resolver.ts
- [Phase 03.1-remove-multi-upstream-mcp-support]: Legacy-array tolerance preserved at MIGRATION-CLEANUP sites: env-var collector (reads raw JSON pre-Zod) and hasUpstreamMcpFlag (list-view UX) for migration period
- [Phase 03.2-profile-env-var-description]: Parse-time D-05 conflict detection skipped: profile list unavailable at parse time; deferred to resolveProfileAdminDescriptions which receives both map and profiles
- [Phase 03.2-profile-env-var-description]: adminDescription field rides inside existing safeJsonForHtml(enriched) blob — no separate template variable needed; Plan 03 reads it client-side from the JSON payload
- [Phase 03.2-profile-env-var-description]: null -> undefined conversion at HttpTransport call site (this.profileAdminDescriptions ?? undefined) so setter accepts Map|null while buildProfileIndexPayload signature uses Map|undefined
- [Phase 03.2-profile-env-var-description]: Admin description inserted between profile-title and profile-subtitle via ternary (not ||) — both undefined and empty string suppress the div
- [Phase 03.2-profile-env-var-description]: safeJsonForHtml escapes only '<' not '>'; test assertions must use literal '>' for tag closings in expected rendered output

### Roadmap Evolution

- Phase 03.1 inserted after Phase 03: Remove multi upstream MCP support (URGENT)
- Phase 03.2 inserted after Phase 03.1: Profile env-var description field — optional per-env-var description shown before profile description in HTML index, for admin configuration guidance (URGENT)
- Phase 03.3 inserted after Phase 03.2: Graceful OAuth degradation for incomplete config (URGENT)

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 1: SSE upstream connection state machine design needs concrete API design before implementation (research flag)
- Phase 1: MCP protocol version negotiation - upstream compatibility matrix needed early
- Phase 3: Credential pass-through transport design (custom header vs init params) needs MCP spec validation

## Session Continuity

Last session: 2026-05-03T22:51:53.266Z
Stopped at: Completed 03.2-03-PLAN.md
Resume file: None
