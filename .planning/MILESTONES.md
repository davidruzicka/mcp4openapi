# Milestones

## v1.0 Enterprise MCP Gateway (Shipped: 2026-05-19)

**Phases completed:** 8 phases, 25 plans, 58 tasks

**Key accomplishments:**

- Per-session upstream MCP connection manager with lazy connect, concurrent dedup, heartbeat pings, and session-scoped cleanup — full upstream session lifecycle (PROXY-01, REL-01/02)
- Pass-through credential forwarding: client-supplied Bearer token forwarded directly to upstream; profile-per-upstream model; no gateway-side credential storage (PROXY-02, SEC-02)
- Bearer redaction with diagnostic suffix preservation and SSRF-protected upstream validation endpoint (SEC-02, REL-03)
- tools/list and tools/call forwarded to upstream MCP servers with tool sanitization (injection-safe), typed error mapping, and tools/list_changed notification relay with bounded queue replay (PROXY-03, PROXY-04, SEC-01, REL-04)
- M2M API key auth gate: ClientAuthGate wired before any upstream connection; HMAC-SHA256 constant-time comparison; clientPrincipal attached to session (AUTH-02, partial AUTH-03)
- AES-256-GCM encrypted token envelopes (`mcp4.v1.*`) for restart-resilient OAuth sessions in k8s; backward-compatible with plain Bearer tokens
- Graceful OAuth degradation: isOAuthConfigOperational pre-flight prevents 500s on incomplete config; oauthDisabledReason hides OAuth tab and skips challenge
- Profile.upstream_mcp narrowed from array to singular in type system (Zod rejects array at parse time); BREAKING CHANGE with migration hint
- Admin-supplied HTML descriptions per profile via MCP4_PROFILES_DESCRIPTION env var; raw render in index detail card; fail-fast on invalid JSON or duplicate keys
- Structured audit:tool_call log at every tool-call outcome + Prometheus upstream_host/client_identity dimensions on mcp_tool_calls_total/duration/errors (OBS-01, OBS-02)
- GET /ready readiness probe — 503 until at least one profile loaded; gates Kubernetes readinessProbe and load balancer traffic (OBS-03)

### Known Gaps

- **AUTH-01** — OIDC JWT client validation not implemented. Phase 6 (Client Auth Gate OIDC JWT) not started. Deferred to v1.1.

### Tech Debt

- Stale comment at `mcp-server.ts:1502-1505` (Phase 3 guard exists but comment not updated)
- OBS-02 wording says "per-client-identity" Prometheus labels but client_identity is intentionally audit-log only (cardinality guard, documented in 04-01-SUMMARY.md)
- REQUIREMENTS.md traceability had stale phase numbers (AUTH-01: "Phase 4" should be "Phase 6"; OBS-*: "Phase 5" should be "Phase 4") — archived with stale values in milestones/v1.0-REQUIREMENTS.md

---
