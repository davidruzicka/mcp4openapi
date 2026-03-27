# Stack Research: Enterprise MCP Gateway Additions

**Project:** mcp4openapi - Enterprise MCP Gateway
**Researched:** 2026-03-26
**Mode:** Ecosystem (subsequent milestone - additions only)

## Recommended Additions

### Upstream MCP Client Sessions

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@modelcontextprotocol/sdk` | 1.28.0 (upgrade from 1.26.0) | MCP Client + StreamableHTTPClientTransport for upstream connections | Already a dependency. The SDK includes `Client` class and `StreamableHTTPClientTransport` for connecting to remote MCP servers over HTTP. Upgrading to 1.28.0 picks up session management fixes. Same package, no new dependency. |

**Integration note:** Import `Client` from `@modelcontextprotocol/sdk/client/index.js` and `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`. Each downstream session creates its own upstream `Client` instance with pass-through credentials. Session lifecycle (connect, reconnect, close) maps directly to the existing per-session HTTP transport model.

**Confidence:** HIGH - the SDK is already in use; Client and StreamableHTTPClientTransport are core documented APIs.

---

### Client Authentication (OIDC/SSO)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `openid-client` | 6.8.x | OIDC Relying Party - discover IdP, validate ID tokens, introspect tokens | Same author as `jose` (Filip Skokan / panva). ESM-native, uses WebCryptoAPI, OpenID Certified. Covers Entra ID, Okta, Keycloak discovery and token validation out of the box. |

**Why openid-client and not raw jose:**
- `jose` handles JWT signing/verification (already used for OAuth provider role)
- `openid-client` handles the RP side: OIDC discovery (`.well-known/openid-configuration`), token introspection, userinfo, token exchange
- They complement each other; `openid-client` v6 uses `jose` internally
- Same author means consistent API philosophy, shared security posture

**Why not passport.js:**
- Passport adds session/cookie middleware designed for browser login flows
- The gateway validates bearer tokens from MCP clients (machine-to-machine and programmatic), not browser redirects
- Passport's plugin model adds indirection without value for headless token validation

**API key auth:** No library needed. Implement as a simple Express middleware that looks up hashed keys in config/database and resolves to a team identity. Zod validates the key format.

**Confidence:** HIGH - openid-client is OpenID Certified, same author as jose, ESM-native, well-documented.

---

### OpenTelemetry Tracing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@opentelemetry/sdk-node` | 0.213.x | Node.js SDK bootstrapper - initializes trace provider, propagators, resource detection | Single entry point for OTel setup. Handles W3C trace context propagation, resource attributes, span processors. |
| `@opentelemetry/api` | 1.9.x | Trace/context API for manual span creation | Stable API; used in application code to create custom spans (tool call, upstream proxy, policy check). Decoupled from SDK version. |
| `@opentelemetry/instrumentation-express` | 0.47.x | Auto-instrument Express routes and middleware | Automatically creates spans for HTTP requests through Express. Works with Express 5. |
| `@opentelemetry/instrumentation-http` | 0.213.x | Auto-instrument outbound HTTP (upstream MCP calls) | Required dependency for Express instrumentation. Also traces outbound fetch/http calls to upstream MCP servers. |
| `@opentelemetry/exporter-trace-otlp-http` | 0.213.x | Export traces via OTLP/HTTP to any collector (Jaeger, Grafana Tempo, etc.) | OTLP is the standard export protocol. HTTP transport works behind corporate proxies. |

**Why NOT `@opentelemetry/exporter-prometheus` for metrics:**
- The codebase already uses `prom-client` directly with a custom `MetricsCollector` class
- `prom-client` already supports OTel exemplars (traceId/spanId labels) natively
- Adding OTel metrics alongside prom-client creates registry conflicts and duplicate metric names
- Strategy: keep prom-client for metrics, add OTel for tracing only, link them via trace exemplars

**Why NOT `@opentelemetry/auto-instrumentations-node`:**
- Kitchen-sink package that instruments 30+ libraries (DNS, FS, gRPC, pg, mysql, redis, etc.)
- Adds unnecessary overhead and dependency weight for a gateway that only needs HTTP + Express instrumentation
- Pick specific instrumentations instead

**Confidence:** HIGH - OpenTelemetry JS SDK 2.0 is stable, Express instrumentation is well-maintained, OTLP is the industry standard.

---

### Audit Logging

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `pino` | 10.3.x | Structured JSON audit logger | Fastest Node.js logger (5x faster than winston). Native JSON output. Child loggers for per-request context. Transport pipeline for routing audit logs separately from app logs. |
| `pino-http` | 10.x | Express middleware for HTTP request logging | Auto-logs request/response with duration, status, correlation IDs. Integrates with pino's transport system. |

**Why pino and not extending the existing custom logger:**
- The existing `ConsoleLogger`/`JsonLogger` in `src/core/logger.ts` is adequate for application logging
- Audit logging has different requirements: guaranteed persistence, structured schema, separate transport (file/stream/external), compliance retention
- Pino's transport pipeline can route audit events to a dedicated file/stream while app logs go to stdout
- Pino child loggers attach per-request context (clientId, teamId, toolName) without global state

**Why not winston:**
- 5x slower than pino in benchmarks
- Heavier dependency tree
- Pino's transport architecture (worker threads) is more suitable for high-throughput gateway audit

**Coexistence with existing logger:**
- Keep existing `ConsoleLogger`/`JsonLogger` for application-level logging (startup, errors, debug)
- Use pino exclusively for the audit log stream (tool calls, policy decisions, auth events)
- Two separate concerns, two separate loggers

**Confidence:** HIGH - pino is the de facto standard for high-performance structured logging in Node.js.

---

### Policy Enforcement

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| No external library | - | Team-level allow/deny policy engine | The policy model is simple: team identity maps to allowed/denied upstream servers and tool names. This is a lookup table, not RBAC/ABAC. |

**Why NOT casbin (node-casbin 5.49.x):**
- Casbin is designed for complex RBAC/ABAC with policy files, model definitions, and adapter backends
- The gateway's v1 policy is a flat allow/deny list per team - a `Map<teamId, { allow: Set<string>, deny: Set<string> }>` is sufficient
- Adding Casbin for a simple lookup adds 15+ transitive dependencies and a learning curve for a feature that's a 50-line module
- If policy complexity grows to ABAC later (explicitly out of scope per PROJECT.md), Casbin can be introduced then

**Implementation approach:**
- Zod-validated policy config in the profile or a separate policy JSON file
- In-memory policy map loaded at startup, reloadable via SIGHUP or config watch
- Policy check runs after client identity resolution, before upstream connection

**Confidence:** HIGH - the policy model is explicitly scoped to allow/deny; no external library needed.

---

## Supporting Libraries (Already Present, No Changes)

| Library | Current Version | Role in Gateway |
|---------|----------------|-----------------|
| `jose` | 6.2.1 | JWT verification for API keys; JWK set fetching for OIDC token validation |
| `zod` | 3.x | Validate policy configs, upstream provider configs, audit log schemas |
| `prom-client` | (current) | Metrics emission - add gateway-specific counters (upstream calls, policy denials, auth failures) |
| `express` | 5.2.1 | HTTP transport - add OIDC middleware, audit middleware |
| `express-rate-limit` | (current) | Rate limit per client identity (extend existing) |

---

## Complete Installation

```bash
# Upgrade existing
npm install @modelcontextprotocol/sdk@^1.28.0

# OIDC client authentication
npm install openid-client@^6.8.0

# OpenTelemetry tracing
npm install @opentelemetry/sdk-node@^0.213.0 \
            @opentelemetry/api@^1.9.0 \
            @opentelemetry/instrumentation-express@^0.47.0 \
            @opentelemetry/instrumentation-http@^0.213.0 \
            @opentelemetry/exporter-trace-otlp-http@^0.213.0

# Audit logging
npm install pino@^10.3.0 pino-http@^10.0.0

# Dev dependencies (tracing test support)
npm install -D @opentelemetry/sdk-trace-base@^2.6.0
```

**Total new runtime dependencies:** 3 packages (openid-client, pino, pino-http) + 5 OTel packages
**Total new dev dependencies:** 1 package

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| OIDC | openid-client 6.x | passport + passport-openidconnect | Passport adds session/cookie middleware for browser flows; gateway validates bearer tokens headlessly |
| OIDC | openid-client 6.x | Manual jose-only OIDC | Would need to implement discovery, introspection, userinfo manually; openid-client is same author as jose |
| Tracing | OTel SDK + targeted instrumentations | @opentelemetry/auto-instrumentations-node | Kitchen sink; instruments 30+ libraries the gateway doesn't use |
| Tracing | OTel tracing only | OTel tracing + OTel metrics | prom-client already in use; dual metrics registries cause conflicts |
| Audit log | pino | winston | 5x slower, heavier deps, no worker-thread transports |
| Audit log | pino (separate) | Extend existing custom logger | Audit has different requirements (persistence, schema, separate transport) |
| Policy | In-house allow/deny map | node-casbin | Overkill for flat allow/deny; 15+ transitive deps for a 50-line module |
| Policy | In-house allow/deny map | OPA (Open Policy Agent) | External sidecar process; deployment complexity for simple team-level rules |
| Upstream MCP | @modelcontextprotocol/sdk Client | Custom HTTP client | SDK already handles MCP protocol framing, SSE reconnection, session IDs |

---

## What NOT to Use

### Do NOT use passport.js
- Designed for browser login flows with session cookies
- The gateway validates bearer tokens from MCP clients, not browser redirects
- Adds middleware indirection without value for headless token validation

### Do NOT use @opentelemetry/auto-instrumentations-node
- Instruments DNS, FS, gRPC, databases, and 25+ other libraries not in use
- Adds startup overhead and dependency weight
- Use targeted instrumentations: `instrumentation-http` + `instrumentation-express`

### Do NOT add @opentelemetry/exporter-prometheus
- Conflicts with existing prom-client metrics registry
- prom-client already supports OTel exemplars (traceId/spanId) natively
- Keep prom-client for metrics, OTel for tracing; link via exemplars

### Do NOT use node-casbin for v1 policy
- The policy model is a flat allow/deny per team, not RBAC/ABAC
- A Zod-validated Map is simpler, faster, and has zero dependencies
- Revisit if policy complexity grows beyond team-level rules

### Do NOT use winston for audit logging
- 5x slower than pino in benchmarks
- Synchronous by default (pino uses worker threads for transports)
- Heavier dependency tree for equivalent functionality

### Do NOT replace the existing custom logger
- The existing ConsoleLogger/JsonLogger works for application logging
- Audit logging is a separate concern with different requirements
- Two loggers, two purposes - no consolidation needed

---

## Integration Notes

### openid-client + jose coexistence
Both maintained by Filip Skokan (panva). openid-client v6 uses jose internally. They share the same WebCryptoAPI approach. No conflicts - openid-client handles OIDC discovery/validation, jose continues to handle raw JWT operations for the existing OAuth provider.

### OpenTelemetry + prom-client coexistence
- prom-client 15.x+ has built-in OTel exemplar support: metrics automatically include `{traceId, spanId}` labels when OTel context is active
- OTel handles tracing (spans, propagation); prom-client handles metrics (counters, histograms)
- No `@opentelemetry/sdk-metrics` needed - avoids dual registry conflicts
- Trace context flows through Express middleware into the existing MetricsCollector via OTel's context propagation

### pino audit logger + existing logger
- App logger (`src/core/logger.ts`): continues handling startup messages, debug logs, error reporting
- Audit logger (pino): dedicated instance for compliance-grade structured logs (tool calls, auth events, policy decisions)
- Separate transports: app logs to stdout, audit logs to file/stream via pino's transport pipeline
- Both share correlation IDs from the existing `generateCorrelationId()` utility

### MCP Client + existing session model
- Each downstream HTTP session spawns upstream `Client` instances as needed
- Upstream credentials extracted from session context (pass-through model)
- Session cleanup closes upstream clients (existing session lifecycle hooks)
- `StreamableHTTPClientTransport` handles SSE reconnection and `Mcp-Session-Id` tracking

### Express 5 compatibility
- `@opentelemetry/instrumentation-express` supports Express 5 (verified in OTel contrib repo)
- pino-http works as standard Express middleware - no version conflicts
- openid-client is transport-agnostic (uses fetch API); integrates via custom Express middleware

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| MCP SDK upgrade (1.28.0) | HIGH | Same package, documented Client API, verified npm version |
| openid-client 6.x | HIGH | OpenID Certified, same author as jose, ESM-native, verified npm version 6.8.2 |
| OpenTelemetry SDK | HIGH | SDK 2.0 stable, 0.213.x verified on npm, Express 5 instrumentation available |
| OTel + prom-client coexistence | MEDIUM | prom-client exemplar support documented; registry isolation approach is standard but needs testing |
| pino 10.x | HIGH | Verified npm version 10.3.1, well-established for structured audit logging |
| No-library policy engine | HIGH | Policy model explicitly scoped to allow/deny in PROJECT.md; revisit only if scope changes |
| Express 5 + OTel instrumentation | MEDIUM | OTel Express instrumentation lists Express 5 support but it is not the default tested version; needs integration test |

---

## Sources

- [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) - version 1.28.0
- [MCP TypeScript SDK client docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md)
- [openid-client on npm](https://www.npmjs.com/package/openid-client) - version 6.8.2
- [openid-client GitHub (panva)](https://github.com/panva/openid-client)
- [OpenTelemetry JS SDK 2.0 announcement](https://opentelemetry.io/blog/2025/otel-js-sdk-2-0/)
- [@opentelemetry/sdk-node on npm](https://www.npmjs.com/package/@opentelemetry/sdk-node) - version 0.213.0
- [@opentelemetry/instrumentation-express on npm](https://www.npmjs.com/package/@opentelemetry/instrumentation-express)
- [@opentelemetry/exporter-prometheus on npm](https://www.npmjs.com/package/@opentelemetry/exporter-prometheus)
- [Prometheus and OpenTelemetry - Better Together](https://opentelemetry.io/blog/2024/prom-and-otel/)
- [pino on npm](https://www.npmjs.com/package/pino) - version 10.3.1
- [pino logger guide (SigNoz 2026)](https://signoz.io/guides/pino-logger/)
- [node-casbin on npm](https://www.npmjs.com/package/casbin) - version 5.49.0
