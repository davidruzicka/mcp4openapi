# Phase 3: Prior Art - Client Authentication Gate

Prior art collected before planning to avoid re-inventing solved problems.

---

## microsoft/mcp-gateway

**Repo:** https://github.com/microsoft/mcp-gateway
**Lang:** C# / .NET 8
**Stars:** ~560 (April 2026)
**Focus:** Kubernetes-native reverse proxy and management layer for MCP servers

### What they do for auth

- **Identity provider:** Azure Entra ID (OIDC) only - not provider-agnostic
- **Token validation:** Bearer JWT validated at the gateway before routing; unauthenticated requests are rejected before any backend (upstream MCP server) is touched
- **RBAC:** Role-based access via Entra ID roles (`mcp.engineer`, `mcp.admin`); read vs. write scopes enforced at control plane (adapter/tool management)
- **M2M / API keys:** Not mentioned in README - appears to be JWT-only
- **Identity propagation:** Identity resolved from JWT; role claims used for RBAC; no explicit mention of attaching identity to audit log entries per-call

### Architecture decisions worth noting

1. **Auth as gateway middleware, not upstream concern** - validation happens in the data plane before routing, never forwarded to the upstream MCP server. This aligns with our AUTH-01/AUTH-02 approach.
2. **Session affinity keyed on `session_id`** - same pattern as our per-session UpstreamConnectionManager; their sticky routing confirms this is the right granularity.
3. **Control plane separation** - adapter/tool registration is a separate REST API from the data plane MCP routing. Not relevant for phase 3 but worth keeping in mind for phase 4 admin endpoints.
4. **No credential forwarding to upstream** - they treat upstream MCP servers as trusted internal services. We forward client credentials upstream (phase 1 design) which is a deliberate difference.

### What they don't do (that we need)

- **Provider-agnostic JWKS** - they hard-code Entra ID; we need configurable `jwks_uri` to support Okta, Keycloak, etc. (AUTH-01)
- **API key store** - no M2M key validation; we need this for AUTH-02
- **Tool poisoning sanitization** - not mentioned; we have this (SEC-01, phase 2)
- **Identity in audit log per call** - mentioned conceptually but no structured per-call audit trail; this is AUTH-03 + OBS-01

### Gaps to investigate before planning

- How does their JWT middleware handle token expiry mid-session? (do they re-validate on each request or only at session init?)
- Do they support JWKS key rotation / cache invalidation?
- How is client identity scoped - per-session or per-request?

---

## Relevant open-source patterns (general)

### JWKS validation
- Standard approach: fetch `{issuer}/.well-known/openid-configuration` → extract `jwks_uri` → cache JWKS with TTL → verify JWT signature + `iss`/`aud`/`exp` claims
- Libraries: `jose` (npm, provider-agnostic, well-maintained) or `jsonwebtoken` + manual JWKS fetch
- Key rotation: JWKS must be re-fetched on unknown `kid`; cache with max-age from `Cache-Control` or fallback TTL (e.g., 1h)

### API key validation
- Common patterns: hashed key in DB/config, constant-time comparison to prevent timing attacks
- Identity resolution: key → `{ clientId, scopes, metadata }` struct attached to request context
- Rate limiting hook point: key resolution is where per-client rate limits are naturally enforced

### Session vs. request identity scope
- Session-scoped: identity resolved once at `POST /mcp` (session init), stored in session context - simpler, matches AUTH-03
- Request-scoped: re-validate on every request - more secure for long-lived sessions but adds latency
- Recommendation: validate at session init + attach to session; re-validate exp on each request (cheap check, no network)
