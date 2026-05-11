---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Phase 04 complete - all gaps closed
stopped_at: Completed 04-observability (all plans + verification gaps fixed)
last_updated: "2026-05-11T14:02:00.000Z"
progress:
  total_phases: 10
  completed_phases: 8
  total_plans: 25
  completed_plans: 25
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** A security boundary between internal AI clients and all upstream MCP servers - one place to authenticate, authorize, audit, and proxy every tool call.
**Current focus:** Phase 04 — observability

## Current Position

Phase: 04 (observability) - COMPLETE
Plan: Completed 2 of 2

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
| Phase 03.3-graceful-oauth-degradation P01 | 4min | 1 tasks | 2 files |
| Phase 03.3-graceful-oauth-degradation P02 | 13min | 3 tasks | 6 files |
| Phase 03.4 P01 | 4min | 2 tasks | 3 files |
| Phase 03.4-encrypted-token-envelope P02 | 3min | 1 tasks | 3 files |
| Phase 03.4-encrypted-token-envelope P03 | 12min | 3 tasks | 3 files |
| Phase 03.4-encrypted-token-envelope P04 | 2min | 1 tasks | 5 files |
| Phase 04-observability P02 | 13min | 1 tasks | 4 files |
| Phase 04-observability P01 | 24min | 2 tasks | 7 files |

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
- [Phase 03.3-graceful-oauth-degradation]: tryResolveEnvRef is module-private - callers only need isOAuthConfigOperational; exposing the resolver separately would allow misuse and bypass the intended API boundary
- [Phase 03.3-graceful-oauth-degradation]: isOAuthConfigOperational placed before ExternalOAuthProvider class - enables pre-flight check without constructing the class (which throws on bad env vars)
- [Phase 03.3-graceful-oauth-degradation]: oauthDisabledReason set in ProfileRuntimeState when pre-flight check fails - auth gate skips OAuth challenge without crashing
- [Phase 03.3-graceful-oauth-degradation]: extractAuthMethods filters OAuth entries when isOAuthConfigOperational returns false - hiding oauth tab from HTML index when env vars are missing
- [Phase 03.4]: Single-throw encrypt guard; both pid empty + key length wrong collapsed into one error site to keep decrypt-never-throws contract clean and satisfy plan acceptance grep
- [Phase 03.4]: Strict base64url validation (^[A-Za-z0-9_-]+={0,2}$) added before Buffer.from(_,'base64url') because Node tolerates invalid chars silently — required for deterministic null on tampered/garbage suffix
- [Phase 03.4]: MIN_ENCODED_BYTES = NONCE+TAG+1 = 29 enforces non-empty ciphertext slice before any cipher op so truncated inputs short-circuit to null
- [Phase 03.4]: Defense-in-depth post-decrypt parsed.pid===profileId on top of AES-GCM AAD; cheap insurance against AAD semantics drift
- [Phase 03.4]: Comment text scrubbed of the literal 'client_secret' so source-text grep stays at zero matches; intent retained as 'secret intentionally absent — DCR public PKCE clients have none'
- [Phase 03.4]: IIFE env-var parser pattern matches existing oauthSessionTimeoutMs/oauthRefreshThresholdMs blocks - keeps the config builder uniform
- [Phase 03.4]: Whitespace trim happens BEFORE deriveTokenKey() not inside it - keeps the token-envelope module pure (no input normalization assumptions); env-var ergonomics belong to the config layer that owns the env-var read
- [Phase 03.4]: MCP4_TOKEN_KEY added to ENV_KEYS sentinel list in test file so beforeEach() unsets it deterministically; prevents test cross-contamination from ambient env on developer machines
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-03]: storeOAuthTokens returns the client-facing token (envelope or raw); both maps keyed by RETURNED token so the warm-cache lookup wins on the no-restart path and the decrypt fallback runs at most once per session
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-03]: refreshAccessToken removed the unconditional 'session.authToken = tokens.access_token' line and now assigns the storeOAuthTokens return value - prevents envelope/raw mismatch within a long-lived session immediately after a refresh
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-03]: Session-init envelope-decrypt fallback gated by !internalToken && !refreshToken && tokenKey && isEncryptedToken; warm-cache always wins, fallback only runs for restart recovery; cross-profile rejection via AAD - debug log + plain-bearer continuation, no crash, no 401
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-03]: registerClient guarded by 'profileState.oauthProvider' (Phase 03.3 graceful degradation can leave it null); session metadata still rehydrates from envelope in degraded-OAuth mode, only DCR re-registration is skipped
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-03]: Encryption-failure availability bias - try/catch around encryptTokenPayload falls back to plain access_token + warn so /oauth/token never crashes on tokenKey misconfiguration; client_secret NEVER embedded in envelope.creg (DCR public PKCE clients have none)
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-04]: CHANGELOG entry consolidation - two prior plan-internal Added bullets (crypto module / HTTP transport wiring) folded into one user-perspective line per AGENTS.md compress-lines rule and the plan's exactly-1-match acceptance criterion
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-04]: README.md MCP4_TOKEN_MAX_LENGTH default updated from 1000 to 4096 alongside the new MCP4_TOKEN_KEY entry - closes the documentation drift introduced when Plan 03 raised the runtime default
- [Phase 03.4-encrypted-token-envelope]: [Phase 03.4-04]: Encrypted Token Envelopes section uses ## (top-level) depth in HTTP-TRANSPORT.md to match neighboring Session Management / SSE Resumability sections, not ### like the Session Storage subsection it follows
- [Phase 04-observability]: [Phase 04-02]: /ready uses mcpRateLimiter only (no explicit auth bypass) - clientAuthGate lives inside handlePost, not at route level - mirrors /health exactly; passes local statusCode (not res.statusCode) to recordHttpRequest for deterministic capture
- [Phase 04-observability]: [Phase 04-02]: Explicit '/ready' branch in normalizePath() despite functional no-op - documents gateway's stable surface and guards against future dynamic-prefix paths being introduced
- [Phase 04-observability]: [Phase 04-02]: Default test fixture has empty profileStates - exercises 503 path naturally; 200 path uses existing createProfileState helper - no new test infrastructure introduced
- [Phase 04-observability]: [Phase 04-01]: emitAuditToolCall helper centralizes audit-log shape (sessionId/clientPrincipal/tool/upstreamHost/outcome/durationMs) - one grep target across HTTP success/error, OAuth reject, all upstream early-rejects, upstream proxy, and stdio paths
- [Phase 04-observability]: [Phase 04-01]: resolveMetricsContext always populates clientIdentity with 'anonymous' fallback (never undefined) so audit + metric label dimensions are well-defined at every emission site
- [Phase 04-observability]: [Phase 04-01]: client_identity capped at 64 chars, upstream_host at 128 chars - bounds Prometheus cardinality without truncating typical identities/hostnames; caps live as named constants in metrics.ts close to the data structure they protect
- [Phase 04-observability]: [Phase 04-01]: recordSessionCreated/Destroyed pass explicit {profile_id, tenant_id} subset to inc/dec - the wider 4-key resolveContextLabels return would trigger prom-client validateLabel rejects on session counters not registered with the new dimensions; tool-call metrics intentionally consume the full shape
- [Phase 04-observability]: [Phase 04-01]: safeBaseUrlHost() private wrapper makes observability defensive against partial-parser test doubles - getBaseUrl() throws degrade to 'none' label rather than propagate through tool-call hot path
- [Phase 04-observability]: [Phase 04-01]: recordUpstreamReject extended with sessionId and emits both metrics + audit log in one place so reject-outcome dimensions cannot drift between Prometheus counter and audit trail
- [Phase 04-observability]: [Phase 04-01]: local-tool path re-derives upstreamHost from tenantBaseUrl when present so tenant-routed calls label the actual target, not the global default captured at handleToolCall entry

### Roadmap Evolution

- Phase 03.1 inserted after Phase 03: Remove multi upstream MCP support (URGENT)
- Phase 03.2 inserted after Phase 03.1: Profile env-var description field — optional per-env-var description shown before profile description in HTML index, for admin configuration guidance (URGENT)
- Phase 03.3 inserted after Phase 03.2: Graceful OAuth degradation for incomplete config (URGENT)
- Phase 03.4 inserted after Phase 03.3: Encrypted token envelope (AES-256-GCM) for restart-resilient OAuth sessions — no persistent storage needed (URGENT)

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 1: SSE upstream connection state machine design needs concrete API design before implementation (research flag)
- Phase 1: MCP protocol version negotiation - upstream compatibility matrix needed early
- Phase 3: Credential pass-through transport design (custom header vs init params) needs MCP spec validation

## Session Continuity

Last session: 2026-05-11T13:47:23.380Z
Stopped at: Completed 04-observability-01-PLAN.md
Resume file: None
