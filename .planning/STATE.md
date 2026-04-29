---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Ready to execute
stopped_at: Completed 03-01-PLAN.md
last_updated: "2026-04-29T13:04:36.999Z"
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 11
  completed_plans: 9
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** A security boundary between internal AI clients and all upstream MCP servers - one place to authenticate, authorize, audit, and proxy every tool call.
**Current focus:** Phase 03 — client-authentication-gate

## Current Position

Phase: 03 (client-authentication-gate) — EXECUTING
Plan: 2 of 3

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

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 1: SSE upstream connection state machine design needs concrete API design before implementation (research flag)
- Phase 1: MCP protocol version negotiation - upstream compatibility matrix needed early
- Phase 3: Credential pass-through transport design (custom header vs init params) needs MCP spec validation

## Session Continuity

Last session: 2026-04-29T13:04:36.996Z
Stopped at: Completed 03-01-PLAN.md
Resume file: None
