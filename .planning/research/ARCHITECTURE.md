# Architecture Research: Enterprise MCP Gateway/Proxy

**Domain:** MCP proxy/gateway with enterprise auth, policy, and upstream management
**Researched:** 2026-03-26
**Overall confidence:** HIGH (existing codebase well-understood, gateway patterns well-documented in industry)

## Gateway Pipeline Model

### Industry Pattern: Filter Chain Pipeline

API gateways (Kong, Envoy, AWS APIGW) universally follow a **filter chain pipeline** where each request passes through an ordered sequence of middleware stages. The canonical ordering is:

```
Ingest -> TLS/Transport -> Auth(n) -> Auth(z)/Policy -> Rate Limit -> Route -> Transform -> Execute -> Audit -> Response
```

Key insight from Envoy's MCP implementation: MCP is **stateful** (sessions, SSE streams), so the pipeline must distinguish between **session lifecycle events** (initialize, reconnect, terminate) and **operational requests** (tools/list, tools/call). Traditional API gateways handle stateless HTTP; MCP gateways must add a session management layer between routing and execution.

### Proposed Pipeline for mcp4openapi Gateway Mode

```
                     INBOUND PIPELINE (per-request)
  +------------------------------------------------------------------------+
  |                                                                        |
  | 1. Transport (Express/HTTP)                                            |
  |    - TLS termination, CORS, basic rate limit (existing)                |
  |                                                                        |
  | 2. Client Authentication Gate (NEW)                                    |
  |    - OIDC token validation OR API key lookup                           |
  |    - Resolves client identity (team, principal)                        |
  |    - Rejects unauthenticated requests before any session work          |
  |                                                                        |
  | 3. Session Management (EXTEND existing)                                |
  |    - Initialize: create session, extract upstream credentials           |
  |    - Resume: validate session ID, load session context                 |
  |    - Terminate: cleanup session + upstream connections                  |
  |                                                                        |
  | 4. Policy Enforcement (NEW)                                            |
  |    - Team-level allow/deny checked against tool name + upstream server  |
  |    - Applied on tools/list (filter visible tools)                      |
  |    - Applied on tools/call (reject denied calls)                       |
  |                                                                        |
  | 5. Tool Resolution + Routing (NEW)                                     |
  |    - Determine if tool is OpenAPI-backed or upstream MCP-backed        |
  |    - For upstream: resolve target provider, check connection health     |
  |                                                                        |
  | 6. Execution (EXTEND existing)                                         |
  |    - OpenAPI tools: existing interceptor chain (auth -> cache ->       |
  |      rate-limit -> retry -> fetch)                                     |
  |    - Upstream MCP tools: forward via upstream client connection         |
  |                                                                        |
  | 7. Audit + Observability (NEW)                                         |
  |    - Structured audit log entry (identity, team, tool, outcome)        |
  |    - OTel span close, metrics emission                                 |
  |    - Response returned to client                                       |
  |                                                                        |
  +------------------------------------------------------------------------+

                     UPSTREAM PIPELINE (per-session, background)
  +------------------------------------------------------------------------+
  |                                                                        |
  | A. Upstream Connection Manager (NEW)                                   |
  |    - Per-session upstream MCP client connections                        |
  |    - Lazy connect on first tool call to that provider                  |
  |    - Connection health monitoring, reconnect on failure                |
  |                                                                        |
  | B. Upstream Notification Listener (NEW)                                |
  |    - Subscribe to upstream SSE notifications                           |
  |    - Forward tools/list_changed to downstream client SSE               |
  |    - Buffer notifications during client reconnection                   |
  |                                                                        |
  +------------------------------------------------------------------------+
```

### Why This Ordering

1. **Auth before session**: Prevents unauthenticated clients from consuming session resources or triggering upstream connections.
2. **Session before policy**: Policy needs the resolved client identity (from auth) and the session context (upstream credentials) to make decisions.
3. **Policy before routing**: Rejected requests never reach upstream servers, reducing attack surface and unnecessary load.
4. **Routing before execution**: Clean separation between "where does this go" and "how do we send it."
5. **Audit wraps everything**: Captures both successful and rejected requests for compliance.

## Component Boundaries

### New Components

| Component | Responsibility | Input | Output | State |
|-----------|---------------|-------|--------|-------|
| **ClientAuthGate** | Validate OIDC/API-key, resolve team identity | HTTP request headers | `ClientIdentity` (team, principal, scopes) | Stateless (JWKS cache shared) |
| **PolicyEngine** | Evaluate team allow/deny rules against tool+provider | `ClientIdentity` + tool name + provider name | allow/deny decision | Immutable policy config loaded at startup |
| **UpstreamConnectionManager** | Manage per-session MCP client connections to upstream providers | Session ID + provider config + upstream credentials | `UpstreamMcpClient` handle | Per-session Map of provider connections |
| **UpstreamToolRegistry** | Aggregate tools from all upstream providers for a session | Upstream providers config + discovered tools | Merged, namespaced tool list | Per-session cached tool lists |
| **ToolRouter** | Determine execution path (OpenAPI vs upstream MCP) | Tool name from callTool | Routing decision + target | Stateless lookup |
| **NotificationForwarder** | Relay upstream server notifications to downstream client SSE | Upstream SSE events | Downstream SSE events | Per-session event buffer |
| **AuditLogger** | Persistent structured log of every tool call | Request context + outcome | Audit log entry (structured JSON) | Write-only append |
| **OTelIntegration** | Trace context propagation, span management | Request lifecycle events | OTel spans + context headers | Per-request span context |

### Extended Components (existing, modified)

| Component | What Changes | Why |
|-----------|-------------|-----|
| **SessionData** (type) | Add `clientIdentity`, `upstreamCredentials`, `upstreamConnections` fields | Session must carry auth identity and upstream connection references |
| **HttpTransport** | Add ClientAuthGate middleware before session handling; add upstream credential extraction from initialize params | Gateway mode needs inbound auth gate |
| **MCPServer** | Add ToolRouter dispatch; tools/list aggregates OpenAPI + upstream tools | Dual-source tool serving |
| **ToolFilterService** | Compose with PolicyEngine for team-level filtering | Policy is a superset of existing tool filtering |
| **MetricsCollector** | Add upstream connection metrics, policy decision counters | Observability for new components |

### Unchanged Components

- **OpenAPIParser** - still handles OpenAPI spec loading and indexing
- **ProfileLoader** - still validates profile config (upstream_mcp already in schema)
- **CompositeExecutor** - still handles multi-step OpenAPI tools
- **InterceptorChain** (auth -> cache -> rate-limit -> retry -> fetch) - still handles OpenAPI tool execution
- **SSRFValidator** - still validates URLs (now also for upstream MCP URLs)

## Data Flow

### Session Initialization (Gateway Mode)

```
Client                    Gateway                         Upstream MCP Servers
  |                         |                                    |
  |-- POST /mcp ----------->|                                    |
  |   (initialize request)  |                                    |
  |   Authorization: Bearer |                                    |
  |   X-Upstream-Creds: {}  |                                    |
  |                         |                                    |
  |                    1. ClientAuthGate                          |
  |                       - Validate OIDC/API-key                |
  |                       - Resolve team identity                |
  |                         |                                    |
  |                    2. Create SessionData                     |
  |                       - Store clientIdentity                 |
  |                       - Extract + store upstream creds       |
  |                       - Generate session ID                  |
  |                         |                                    |
  |                    3. PolicyEngine                            |
  |                       - Load team policies                   |
  |                       - Cache allowed providers for session  |
  |                         |                                    |
  |                    4. UpstreamConnectionManager               |
  |                       - DO NOT connect yet (lazy)            |
  |                       - Register provider configs            |
  |                         |                                    |
  |<-- 200 + Mcp-Session-Id |                                    |
  |    (initialize result)  |                                    |
```

### tools/list Flow

```
Client                    Gateway                         Upstream MCP Servers
  |                         |                                    |
  |-- POST /mcp ----------->|                                    |
  |   (tools/list)          |                                    |
  |   Mcp-Session-Id: abc   |                                    |
  |                         |                                    |
  |                    1. Session lookup                          |
  |                    2. PolicyEngine: get allowed tools         |
  |                         |                                    |
  |                    3a. OpenAPI tools from ToolGenerator       |
  |                    3b. Upstream tools (per allowed provider)  |
  |                         |                                    |
  |                         |--- initialize (if first call) ---->|
  |                         |<-- tools/list -------------------- |
  |                         |    (cache in UpstreamToolRegistry) |
  |                         |                                    |
  |                    4. Merge + namespace + policy filter       |
  |                    5. AuditLogger.log(tools/list, result)    |
  |                         |                                    |
  |<-- tools list (merged)  |                                    |
```

### tools/call Flow

```
Client                    Gateway                         Upstream MCP Server
  |                         |                                    |
  |-- POST /mcp ----------->|                                    |
  |   (tools/call)          |                                    |
  |   tool: "github.create_issue"                                |
  |                         |                                    |
  |                    1. Session lookup                          |
  |                    2. PolicyEngine: authorize this call       |
  |                    3. ToolRouter: upstream(github) provider   |
  |                         |                                    |
  |                    4. UpstreamConnectionManager               |
  |                       - Get/create connection for "github"   |
  |                       - Attach upstream credentials           |
  |                         |                                    |
  |                    5. OTel: start span                        |
  |                         |--- tools/call ------------------->|
  |                         |<-- result ------------------------ |
  |                    6. OTel: end span                          |
  |                    7. AuditLogger.log(call, result)           |
  |                         |                                    |
  |<-- tool result          |                                    |
```

### Notification Forwarding Flow

```
Upstream MCP Server           Gateway                      Client
  |                              |                           |
  |-- SSE: tools/list_changed -->|                           |
  |                              |                           |
  |                    1. NotificationForwarder               |
  |                       - Map upstream event to session     |
  |                       - Apply policy filter               |
  |                         |                                |
  |                              |-- SSE: tools/list_changed->|
  |                              |   (on session SSE stream)  |
```

### Credential Flow (Pass-Through Model)

```
Credential lifecycle:
1. Client sends upstream creds at initialize (custom header or init params)
2. Gateway extracts, validates format, stores in SessionData (memory only)
3. On upstream call, UpstreamConnectionManager reads from session, injects into upstream request
4. On session terminate, credentials are garbage-collected with session
5. Credentials NEVER: written to disk, logged, included in error responses, shared across sessions
```

## Integration Points (with existing mcp4openapi)

### Where New Code Plugs In

| Integration Point | Existing Code | New Code | How |
|-------------------|---------------|----------|-----|
| **HTTP middleware chain** | `HttpTransport.setupMiddleware()` | `ClientAuthGate` | Insert as Express middleware before session handler. Existing `EnterpriseAuthProvider` provides JWKS/JWT infra - reuse for OIDC validation |
| **Session creation** | `SessionData` type + session Map in `HttpTransport` | Upstream credential extraction | Extend `SessionData` interface, add extraction logic in initialize handler |
| **tools/list handler** | `MCPServer` registers tools from `ToolGenerator` | `UpstreamToolRegistry` + `ToolRouter` | MCPServer's listTools handler calls ToolRouter which aggregates both sources |
| **tools/call handler** | `MCPServer` dispatches to `CompositeExecutor` or direct HTTP call | `ToolRouter` + `UpstreamConnectionManager` | ToolRouter decides path; upstream path bypasses interceptor chain entirely |
| **Tool filtering** | `ToolFilterService` with strategy pattern | `PolicyEngine` | PolicyEngine wraps/composes with existing ToolFilterService; policy rules are an additional filter layer |
| **Metrics** | `MetricsCollector` with prom-client | OTel metrics + upstream metrics | Extend existing MetricsCollector; add OTel exporter alongside Prometheus |
| **Profile config** | `UpstreamMcpServerConfig` type + `upstream-mcp-config.ts` | Runtime connection from config | Config is already validated; new code consumes it to create upstream connections |
| **SSRF protection** | `SSRFValidator` | Validate upstream MCP URLs | Call existing SSRFValidator on upstream URLs at connection time, not just startup |
| **Token redaction** | Logger auto-redacts based on auth type | Upstream credential redaction | Extend redaction patterns to cover upstream auth headers/tokens |

### Reuse Opportunities

| Existing Component | Reuse For |
|-------------------|-----------|
| `EnterpriseAuthProvider` + `JwksCache` | OIDC token validation for client auth gate (already does JWKS-based JWT validation) |
| `InboundAuthTokenStore` | API key storage/lookup for M2M client auth |
| `SSEStreamState` + message queue | Notification forwarding buffer (same SSE delivery mechanism) |
| `ToolFilterService` strategy pattern | PolicyEngine can implement as another filter rule type (TeamPolicyRule) |
| `generateCorrelationId()` | Correlation IDs for upstream requests and audit log entries |
| Typed error hierarchy | New error types: `PolicyDeniedError`, `UpstreamConnectionError`, `UpstreamTimeoutError` |

### New Dependencies Needed

| Dependency | Purpose | Why This One |
|------------|---------|-------------|
| `@modelcontextprotocol/sdk` (Client) | MCP client for upstream connections | Already a dependency (server side); client is in same package |
| `@opentelemetry/api` + `@opentelemetry/sdk-trace-node` | OTel trace context + spans | Industry standard, non-opinionated about export backend |
| `@opentelemetry/exporter-trace-otlp-http` | Export traces to OTel collector | Standard OTLP exporter for Kubernetes/on-prem collector |

No new framework dependencies. Express, Zod, jose, prom-client all continue as-is.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Monolithic Session Object
**What:** Cramming all upstream state (connections, tool caches, notification buffers) into SessionData.
**Why bad:** SessionData becomes a god object; upstream connection lifecycle becomes entangled with session lifecycle.
**Instead:** SessionData holds references (IDs/keys) to upstream state. UpstreamConnectionManager owns the actual connections, indexed by session ID. Clean separation of lifecycle.

### Anti-Pattern 2: Eager Upstream Connection
**What:** Connecting to all configured upstream providers at session initialization.
**Why bad:** Slow initialize response; wasted connections for providers the client may never use; upstream rate limits burned on idle connections.
**Instead:** Lazy connect on first tools/list or tools/call to that provider. Pre-validate config at init but defer connection.

### Anti-Pattern 3: Synchronous Notification Processing
**What:** Blocking request handling while processing upstream notifications.
**Why bad:** Upstream notification storms can stall client requests.
**Instead:** Notification forwarding runs on a separate async event loop. Buffer in memory with bounded size. Drop oldest on overflow with metrics.

### Anti-Pattern 4: Policy in the Router
**What:** Embedding allow/deny logic in the ToolRouter.
**Why bad:** Policy changes require router changes; hard to test; policy logic scattered.
**Instead:** PolicyEngine is a standalone component. ToolRouter only handles "where does this go." Policy is evaluated before routing.

## Scalability Considerations

| Concern | At 10 sessions | At 1K sessions | At 10K sessions |
|---------|----------------|-----------------|------------------|
| Upstream connections | 10 x N providers, in-memory Map | 1K x N, needs connection pooling per provider | Connection limits per upstream; need pool with max-per-provider cap |
| Session state | In-memory Map, trivial | In-memory Map, ~50MB for 1K sessions | Consider external session store (Redis) or sticky routing |
| Notification buffers | Per-session array, small | Bounded buffer (100 events per session), ~100MB ceiling | Must enforce hard limits; drop + metrics |
| Policy evaluation | In-memory rule lookup, sub-ms | Same, still sub-ms | Same - policy set is small, evaluation is O(rules) not O(sessions) |
| Audit log | Stdout/file append | Structured log to file or stdout -> external collector | Must be async, buffered writes, never block request path |

## Suggested Build Order

Build order follows dependency graph. Each layer requires the one before it.

### Phase 1: Upstream Connection Foundation
**Components:** UpstreamConnectionManager, UpstreamToolRegistry
**Dependencies:** Existing UpstreamMcpServerConfig, MCP SDK client
**Why first:** Everything else (routing, policy, notifications) depends on having working upstream connections.
**Integration:** Extend SessionData with upstream connection references. MCPServer gets a secondary tool source.
**Deliverable:** A session can discover and call tools on a single upstream HTTP MCP server using static credentials (from env vars, existing auth config model).

### Phase 2: Client Authentication Gate
**Components:** ClientAuthGate (OIDC + API keys), ClientIdentity type
**Dependencies:** Existing EnterpriseAuthProvider, JwksCache, InboundAuthTokenStore
**Why second:** Policy enforcement (Phase 3) needs client identity. But Phase 1 can work with static auth for development/testing.
**Integration:** Express middleware inserted before session handler in HttpTransport.
**Deliverable:** Only authenticated clients can create sessions. Identity attached to session.

### Phase 3: Pass-Through Credential Forwarding
**Components:** Credential extraction from initialize, per-session credential store, credential injection in upstream calls
**Dependencies:** Phase 1 (upstream connections), Phase 2 (client identity for audit)
**Why third:** Replaces static env-var credentials from Phase 1 with client-supplied tokens. Core security model.
**Integration:** Extend initialize handler in HttpTransport. UpstreamConnectionManager reads from session credentials instead of env vars.
**Deliverable:** Clients supply their own upstream tokens at session init; gateway forwards them.

### Phase 4: Policy Enforcement
**Components:** PolicyEngine, TeamPolicyRule (integrates with ToolFilterService)
**Dependencies:** Phase 2 (client identity for team resolution), Phase 1 (upstream tools to filter)
**Why fourth:** Auth and connections must work before policy can meaningfully filter.
**Integration:** Composes with existing ToolFilterService. Applied in tools/list and tools/call paths.
**Deliverable:** Teams see only allowed tools; denied tool calls are rejected with clear error.

### Phase 5: Notification Forwarding
**Components:** NotificationForwarder, event buffer
**Dependencies:** Phase 1 (upstream connections with SSE), existing SSE infrastructure
**Why fifth:** Nice-to-have for v1; core proxy works without it. Depends on stable upstream connections.
**Integration:** Hooks into upstream SSE event listeners. Forwards to downstream session SSE streams.
**Deliverable:** Upstream tools/list_changed propagates to connected clients.

### Phase 6: Audit + OpenTelemetry
**Components:** AuditLogger, OTelIntegration
**Dependencies:** All prior phases (audit captures everything; OTel wraps all calls)
**Why last:** Cross-cutting concern that wraps all other components. Can be added incrementally.
**Integration:** AuditLogger wraps tool call handlers. OTel wraps upstream + downstream request lifecycle.
**Deliverable:** Every tool call logged with identity, team, tool, upstream, outcome. Traces propagated.

### Dependency Graph

```
Phase 1 (Upstream Connections)
    |
    +---> Phase 3 (Credential Forwarding) ---> Phase 4 (Policy) ---> Phase 6 (Audit/OTel)
    |                                              ^
    +---> Phase 5 (Notifications)                  |
                                                   |
Phase 2 (Client Auth Gate) ------------------------+
```

Phases 1 and 2 can be built in parallel. Phase 3 depends on Phase 1. Phase 4 depends on Phases 2 and 3. Phase 5 depends on Phase 1 only. Phase 6 depends on all prior phases being stable.

## Sources

- [Envoy AI Gateway MCP Implementation](https://aigateway.envoyproxy.io/blog/mcp-implementation/) - MEDIUM confidence (architecture patterns verified across multiple sources)
- [Microsoft MCP Gateway](https://github.com/microsoft/mcp-gateway) - HIGH confidence (open source, architecture documented)
- [Kong API Gateway Enterprise Architecture 2026](https://calmops.com/network/kong-api-gateway-enterprise-2026/) - MEDIUM confidence
- [Red Hat - Advanced Auth for MCP Gateway](https://developers.redhat.com/articles/2025/12/12/advanced-authentication-authorization-mcp-gateway) - MEDIUM confidence
- [MCP Gateway Architecture Comparison](https://skywork.ai/blog/mcp-server-vs-mcp-gateway-comparison-2025/) - LOW confidence (aggregator content)
- [API Gateway Core Features - API7.ai](https://api7.ai/learning-center/api-gateway-guide/core-api-gateway-features) - MEDIUM confidence
- Existing codebase analysis (src/transport/, src/types/, src/profile/) - HIGH confidence (primary source)
