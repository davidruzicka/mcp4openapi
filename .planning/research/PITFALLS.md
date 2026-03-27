# Pitfalls Research: Enterprise MCP Gateway/Proxy

**Domain:** Enterprise MCP proxy/gateway with pass-through credential forwarding
**Researched:** 2026-03-26
**Overall confidence:** HIGH (combines OWASP MCP Top 10, real CVEs, MCP spec analysis, and codebase review)

---

## Security Pitfalls

### S1: Credential Leakage Through Error Messages and Logs

**Severity:** CRITICAL
**What goes wrong:** Pass-through credentials (upstream tokens supplied by clients at session init) appear in error messages, stack traces, HTTP response bodies, or structured log output. A single leaked JWT in a 500 response gives an attacker the client's upstream access.
**Why it happens:** Error serialization paths are numerous - Node.js `Error.message`, Express default error handler, JSON-RPC error responses, Prometheus metric labels, audit log fields. Each path must independently redact secrets.
**Warning signs:**
- Error responses contain strings matching JWT patterns (`xxx.yyy.zzz`)
- Log grep for `Bearer` or `Authorization` returns matches outside redaction test files
- Upstream HTTP client errors include the full request headers in the error object
**Prevention:**
- Extend the existing `auth-redaction.ts` to cover upstream credential fields (not just OAuth fields like `assertion`, `subject_token`). The current `SECRET_FIELD_NAMES` set does not include upstream-specific header names that pass-through auth will introduce.
- Enforce redaction at the boundary: the JSON-RPC response serializer and the Express error handler must both pass through a redaction filter before sending.
- Add integration tests that inject credentials into error paths and assert they never appear in HTTP response bodies.
- Register a global `uncaughtException` handler that redacts before logging.
**Phase:** Phase 1 (upstream session lifecycle) - credential handling is the first thing built.
**Confidence:** HIGH - based on codebase review of `src/auth/auth-redaction.ts` and known CVE patterns.

### S2: SSRF via Upstream MCP Server URLs

**Severity:** CRITICAL
**What goes wrong:** The gateway connects to upstream MCP server URLs that are either configured by administrators or (in future) negotiated dynamically. If an attacker can influence the upstream URL (via profile injection, DNS rebinding, or redirect chains), they reach internal services.
**Why it happens:** The existing `SSRFValidator` covers proxy downloads but upstream MCP session establishment is a separate code path. The new upstream connection manager must also validate target URLs against SSRF rules. DNS rebinding is particularly dangerous for long-lived SSE connections - the DNS result is valid at connect time but the IP may change during the session.
**Warning signs:**
- Upstream URLs resolve to RFC 1918 / link-local addresses without explicit `allowPrivateNetwork`
- No SSRF validation on the upstream connection establishment path
- Upstream URLs containing hostnames that resolve to different IPs over time
**Prevention:**
- Reuse `SSRFValidator` for upstream MCP connection establishment, not just proxy downloads.
- Pin DNS resolution at connect time and re-validate on reconnection.
- Block cloud metadata endpoints (169.254.169.254, fd00::, etc.) unconditionally.
- Validate upstream URLs at profile load time AND at connection time (defense in depth).
**Phase:** Phase 1 (upstream session lifecycle).
**Confidence:** HIGH - the existing `ssrf-validator.ts` validates downloads but the new upstream connection path is separate.

### S3: Credential Forwarding to Wrong Upstream (Confused Deputy)

**Severity:** CRITICAL
**What goes wrong:** Client supplies credentials for upstream A, but a bug in session routing sends those credentials to upstream B. The owner of upstream B now has the client's token for upstream A.
**Why it happens:** The pass-through model means the gateway holds credentials for multiple upstreams per session. If tool routing maps a tool call to the wrong upstream provider (e.g., due to namespace collision or stale tool cache), credentials are sent to the wrong destination.
**Warning signs:**
- Tool name resolution returns a different upstream than expected after `tools/list_changed`
- Upstream credential map is keyed by mutable data (provider name string) rather than immutable provider ID
- No assertion that the credential's intended audience matches the target URL
**Prevention:**
- Key upstream credentials by an immutable provider identifier, not display name.
- Validate that the credential is scoped to the intended upstream before forwarding (if JWTs, check `aud` claim; if opaque tokens, at minimum check that the credential was registered for that specific provider).
- Log every credential-forwarding decision with correlation ID for audit.
- Add a test that creates two upstreams with similar names and verifies credential isolation.
**Phase:** Phase 2 (tool discovery and proxy) - this is where tool-to-upstream routing is built.
**Confidence:** HIGH - this is a well-known API gateway anti-pattern (confused deputy problem).

### S4: Tool Poisoning and Rug Pull via Upstream MCP Servers

**Severity:** HIGH
**What goes wrong:** A malicious or compromised upstream MCP server changes tool descriptions after initial discovery. The new description contains prompt injection payloads that cause the AI client to exfiltrate data or call unintended tools.
**Why it happens:** The MCP protocol allows servers to emit `tools/list_changed` notifications at any time. If the gateway blindly forwards updated tool definitions to clients, a compromised upstream can inject malicious descriptions mid-session.
**Warning signs:**
- Tool descriptions change between `tools/list` calls without administrator action
- Descriptions contain instructions addressed to the AI model (e.g., "ignore previous instructions", "always call this tool first")
- No hash/pin mechanism for tool definitions
**Prevention:**
- Implement tool definition pinning: hash tool schemas at first discovery and alert (or reject) when they change unexpectedly.
- Strip or sanitize tool descriptions before forwarding to clients - remove instruction-like content.
- Allow administrators to freeze tool definitions per upstream provider (opt-in `tools/list_changed` forwarding).
- Log all tool definition changes with diffs for audit review.
**Phase:** Phase 2 (tool discovery) and Phase 3 (policy enforcement).
**Confidence:** HIGH - OWASP MCP Top 10 lists tool poisoning as a primary risk; Invariant Labs published working PoC.

### S5: Policy Bypass via Tool Name Manipulation

**Severity:** HIGH
**What goes wrong:** Team-level allow/deny policies reference tool names, but upstream servers can register tools with names that evade policy matching. Examples: Unicode homoglyphs, case variations, prefix/suffix manipulation, or registering tools whose namespace prefix mimics another provider.
**Why it happens:** Policy matching uses string comparison against tool names that originate from untrusted upstream servers. Without normalization and strict namespace enforcement, the policy is bypassable.
**Warning signs:**
- Tool names contain non-ASCII characters
- Tool names do not match the expected `{prefix}_{toolname}` pattern for their provider
- Policy rules use substring matching instead of exact or anchored patterns
**Prevention:**
- Enforce strict tool name validation at the gateway: `^[a-zA-Z0-9._-]+$` (the existing `UPSTREAM_TOOL_PREFIX_PATTERN` in `upstream-mcp-config.ts` already uses this pattern for prefixes - extend it to full tool names).
- The gateway, not the upstream, must control the namespace prefix. Upstream-provided tool names are suffixed to the gateway-controlled prefix.
- Normalize tool names (lowercase, NFC Unicode normalization) before policy evaluation - the existing `tool-filter` module already does NFC normalization, so extend this to upstream tools.
- Deny-by-default: if a tool name does not match the expected namespace for its provider, reject it.
**Phase:** Phase 3 (policy enforcement).
**Confidence:** HIGH - existing `tool-filter/` has the right patterns; the risk is not applying them to upstream tools.

### S6: Session Credential Persistence After Revocation

**Severity:** MEDIUM
**What goes wrong:** A client's upstream token is revoked (e.g., rotated, expired, or administratively revoked) but the gateway continues using the cached credential for the remaining session lifetime.
**Why it happens:** Pass-through credentials are stored in session context at initialization. If the upstream token expires during a long-lived session (hours), the gateway has no mechanism to detect this until an upstream call fails with 401.
**Warning signs:**
- Upstream calls start failing with 401/403 mid-session
- Sessions live longer than typical token lifetimes (e.g., 1-hour access tokens in 24-hour sessions)
- No token refresh mechanism for pass-through credentials
**Prevention:**
- Detect upstream 401/403 responses and propagate them to the client with a clear "upstream credential expired" error rather than retrying with the same dead token.
- Expose a session-level mechanism for clients to refresh their upstream credentials without re-initializing the entire session.
- Set session max-lifetime to the shortest upstream token lifetime when known.
- Do NOT silently retry with expired credentials - this masks the problem and wastes upstream rate limits.
**Phase:** Phase 1 (upstream session lifecycle).
**Confidence:** MEDIUM - depends on upstream token lifetime characteristics which vary by provider.

---

## Reliability Pitfalls

### R1: Upstream SSE Connection Lifecycle Mismatch

**Severity:** CRITICAL
**What goes wrong:** The gateway maintains one downstream SSE connection per client and N upstream SSE connections (one per upstream provider). When an upstream connection drops, the gateway either: (a) silently loses notifications, (b) tears down the entire downstream session, or (c) enters a half-open state where the client thinks everything is fine but upstream events are lost.
**Why it happens:** SSE connections can fail silently - TCP keepalive may not detect a dead connection for minutes. Intermediate proxies (nginx, load balancers) may close idle connections without signaling the application layer. The MCP spec (2025-03-26) does not define a heartbeat requirement.
**Warning signs:**
- Upstream notifications stop arriving but no error is logged
- Client `tools/list` returns stale tool definitions
- Gateway memory grows because event queues for dead connections keep accumulating
**Prevention:**
- Implement application-level heartbeats (ping/pong or SSE comments) on upstream connections, independent of TCP keepalive. Send a heartbeat every 15-30 seconds.
- Define explicit connection states: CONNECTING, CONNECTED, RECONNECTING, FAILED. Only forward notifications in CONNECTED state.
- On upstream connection failure, immediately mark affected tools as unavailable (return error for `tools/call`) rather than silently queueing.
- Set bounded reconnection: exponential backoff with a maximum retry count, then transition to FAILED state and notify the client.
- Event replay: use MCP `Last-Event-ID` for upstream reconnection to avoid message gaps.
**Phase:** Phase 1 (upstream session lifecycle).
**Confidence:** HIGH - SSE reliability issues are well-documented; LibreChat issue #11868 demonstrates this exact problem.

### R2: Cascading Failure When One Upstream Is Slow

**Severity:** HIGH
**What goes wrong:** A single slow or unresponsive upstream MCP server blocks tool calls across all upstreams because the gateway shares a connection pool, event loop, or request queue.
**Why it happens:** Node.js single-threaded event loop means a slow upstream response (e.g., 30-second timeout) blocks processing of requests to healthy upstreams if they share the same async pipeline. Compounded when the gateway lacks per-upstream circuit breakers.
**Warning signs:**
- Latency increase on all tool calls when one upstream is degraded
- Client-side timeouts increase across unrelated tools
- No per-upstream timeout or circuit breaker configuration
**Prevention:**
- Per-upstream timeout configuration (already modeled in `UpstreamMcpServerConfig.timeout_ms` - enforce it at the HTTP client level).
- Implement circuit breakers per upstream: after N consecutive failures, stop sending requests and return fast errors.
- Isolate upstream request queues: each upstream provider gets its own connection/request pipeline.
- Use `AbortController` with per-request timeouts, not shared timeout pools.
- Emit per-upstream health metrics (success rate, p99 latency) so operators can detect degradation before cascading failure.
**Phase:** Phase 1 (upstream session lifecycle) for timeouts; Phase 4 (observability) for circuit breakers.
**Confidence:** HIGH - standard API gateway concern.

### R3: Session State Memory Leak

**Severity:** HIGH
**What goes wrong:** Each downstream session holds upstream connection state, credential references, cached tool definitions, and event queues. If sessions are not properly cleaned up on client disconnect, the gateway accumulates memory until it OOMs.
**Why it happens:** SSE connections can disconnect without a clean close (network failure, client crash). The gateway must detect orphaned sessions and clean them up. The existing HTTP transport has session management but adding upstream state per session multiplies the cleanup surface.
**Warning signs:**
- Gateway memory usage grows monotonically over days
- Session count in metrics does not decrease after client disconnects
- Upstream SSE connections remain open after downstream session ends
**Prevention:**
- Implement a session reaper that runs on a fixed interval (e.g., every 60 seconds) and cleans sessions with no activity beyond a configurable timeout.
- When a downstream session ends (clean close or timeout), explicitly close ALL associated upstream connections before freeing session state.
- Set hard limits on max concurrent sessions and max sessions per client identity.
- Add a Prometheus gauge for active sessions and upstream connections so operators can set alerts.
- Use `WeakRef` or explicit cleanup callbacks for upstream state references, not just Map entries.
**Phase:** Phase 1 (upstream session lifecycle).
**Confidence:** HIGH - MCP spec discussion #102 explicitly calls out session garbage collection as a known problem.

### R4: Notification Storm Amplification

**Severity:** MEDIUM
**What goes wrong:** An upstream server emits a burst of `tools/list_changed` notifications (e.g., during its own restart). The gateway forwards each to every connected downstream client, amplifying the burst by the number of clients. Each client then re-fetches `tools/list`, causing a thundering herd of tool discovery requests back through the gateway to the upstream.
**Why it happens:** Naive notification forwarding without deduplication or debouncing. The MCP spec allows servers to emit notifications freely.
**Warning signs:**
- Spike in `tools/list` requests after upstream server restart
- Gateway CPU/memory spike correlated with upstream notification bursts
- Downstream clients all refresh simultaneously
**Prevention:**
- Debounce `tools/list_changed` notifications: buffer for 1-2 seconds and forward at most once per window per upstream.
- Cache upstream `tools/list` responses at the gateway with a short TTL (5-10 seconds) to absorb thundering herd.
- Add jitter to notification forwarding to spread client re-fetches over time.
- Rate-limit upstream notification forwarding per downstream session.
**Phase:** Phase 2 (tool discovery) and Phase 3 (notification forwarding).
**Confidence:** MEDIUM - theoretical but well-understood pattern from event-driven systems.

---

## Operational Pitfalls

### O1: Audit Log Gaps Under Load

**Severity:** HIGH
**What goes wrong:** The audit log is the compliance backbone ("every tool call, every time") but under high load, synchronous audit logging slows tool calls or, if async, drops entries when buffers overflow.
**Why it happens:** Audit logging competes with request processing for I/O bandwidth. If audit writes are synchronous (e.g., file or database), they add latency. If async with bounded buffers, entries are lost under load.
**Warning signs:**
- Tool call latency correlates with audit log write latency
- Missing audit entries for tool calls that are known to have succeeded
- Audit buffer overflow warnings in logs
**Prevention:**
- Use a write-ahead log pattern: append to a local file/buffer first (fast, append-only), then batch-ship to the durable store asynchronously.
- Never drop audit entries silently - if the buffer is full, apply backpressure (slow down tool calls) rather than losing records. This is a policy decision that must be explicit.
- Include a sequence number per session so audit consumers can detect gaps.
- Test audit logging at expected peak load (e.g., 1000 tool calls/sec) and measure latency impact.
**Phase:** Phase 4 (audit and observability).
**Confidence:** HIGH - standard compliance logging concern.

### O2: Insufficient Observability for Multi-Hop Debugging

**Severity:** HIGH
**What goes wrong:** A tool call fails and the operator cannot determine whether the failure was in inbound auth, policy evaluation, upstream connection, upstream auth, upstream execution, or response forwarding. Debugging requires correlating logs across all these stages, which is impossible without distributed tracing.
**Why it happens:** The gateway is a multi-hop system (client -> gateway inbound auth -> policy -> upstream connection -> upstream auth -> upstream MCP -> response). Without trace context propagation, each hop's logs are isolated.
**Warning signs:**
- Operator resorts to timestamp-based log correlation across components
- "Tool call failed" errors with no indication of which stage failed
- No way to measure per-stage latency breakdown
**Prevention:**
- Propagate OpenTelemetry trace context end-to-end: inject `traceparent` header on upstream requests.
- Emit spans for each processing stage: `inbound_auth`, `policy_eval`, `upstream_connect`, `upstream_call`, `response_forward`.
- Include trace ID in all error responses and audit log entries.
- The existing Prometheus metrics (prom-client) cover request-level metrics; add histogram metrics per processing stage.
**Phase:** Phase 4 (request tracing is already in the active requirements as #214).
**Confidence:** HIGH - multi-hop tracing is a solved problem but easy to defer until debugging is painful.

### O3: Configuration Drift Between Gateway Instances

**Severity:** MEDIUM
**What goes wrong:** In a Kubernetes deployment with multiple gateway replicas, profile/policy configuration changes are applied to some replicas but not others. Clients get inconsistent tool lists or policy decisions depending on which replica handles their request.
**Why it happens:** Profile-driven configuration is loaded at startup from files or environment variables. If config changes are deployed via rolling update, there is a window where old and new replicas coexist. If config is loaded from a shared source (ConfigMap, database), cache invalidation timing varies across replicas.
**Warning signs:**
- Same client gets different tool lists on successive requests (sticky sessions not configured)
- Policy allows/denies a tool call inconsistently
- Audit logs show different tool sets for the same team from different replicas
**Prevention:**
- Include a config version hash in health check responses and metrics labels so operators can detect drift.
- If using ConfigMaps, implement a file watcher that triggers graceful reload (not restart).
- Design session affinity: once a client establishes a session, route all requests to the same replica (SSE already requires this; ensure POST requests are also sticky).
- Version tool lists: include an ETag or version in `tools/list` responses so clients can detect inconsistency.
**Phase:** Phase 5 (deployment/packaging).
**Confidence:** MEDIUM - depends on deployment topology.

---

## MCP-Specific Pitfalls

### M1: Protocol Version Mismatch Between Gateway and Upstream

**Severity:** HIGH
**What goes wrong:** The gateway implements MCP spec 2025-03-26 but an upstream server implements a different version (older or newer). The `initialize` handshake succeeds but subsequent operations fail due to incompatible capabilities or message formats.
**Why it happens:** The MCP spec is evolving rapidly. The 2025-06-18 draft introduces changes to transport semantics. Upstream servers may upgrade independently of the gateway.
**Warning signs:**
- Upstream `initialize` response includes unknown capability fields
- `tools/call` requests succeed but return unexpected response structures
- Gateway logs show JSON-RPC parse errors for upstream responses
**Prevention:**
- During upstream `initialize`, record the negotiated protocol version and capabilities.
- Implement version-aware forwarding: if the upstream uses a different protocol version, translate or reject gracefully rather than passing through malformed messages.
- Log protocol version mismatch as a warning, not just a debug message.
- Maintain a compatibility matrix of tested upstream MCP versions.
**Phase:** Phase 1 (upstream session lifecycle) - version negotiation happens at connection time.
**Confidence:** HIGH - the MCP spec has had 3 revisions in 12 months.

### M2: Tool Schema Validation Gap

**Severity:** HIGH
**What goes wrong:** The gateway forwards tool definitions from upstream servers to clients without validating the JSON Schema in the tool's `inputSchema`. A malformed schema causes the AI client to generate invalid tool call arguments, leading to upstream errors that are difficult to debug.
**Why it happens:** The gateway treats upstream tool definitions as opaque and forwards them as-is. There is no validation that `inputSchema` is valid JSON Schema, that it matches what the upstream actually expects, or that it is within size limits.
**Warning signs:**
- Upstream tool `inputSchema` is excessively large (> 100KB)
- `inputSchema` references `$ref` that the client cannot resolve
- Tool calls fail with upstream validation errors despite the client following the schema
**Prevention:**
- Validate upstream tool `inputSchema` against JSON Schema draft-07 (the version MCP uses) before forwarding.
- Enforce size limits on tool definitions (description length, schema size) to prevent memory exhaustion.
- Resolve or reject `$ref` references in tool schemas since clients may not be able to resolve them.
- Log malformed tool schemas as warnings and exclude those tools from the forwarded list.
**Phase:** Phase 2 (tool discovery).
**Confidence:** HIGH - the existing codebase already validates OpenAPI-generated tool schemas rigorously.

### M3: Incomplete MCP Initialize Handshake Proxy

**Severity:** HIGH
**What goes wrong:** The gateway's `initialize` response to clients advertises capabilities that depend on upstream servers, but those upstream connections have not been established yet (or have failed). The client proceeds under false assumptions about available capabilities.
**Why it happens:** The gateway must respond to the client's `initialize` request, but upstream connections may be asynchronous or lazy. If the gateway optimistically advertises upstream-dependent capabilities, it creates a contract it cannot fulfill.
**Warning signs:**
- `tools/list` returns empty after `initialize` reported tool capabilities
- Client calls a tool that was in the capability negotiation but the upstream is not connected
- Race condition between downstream `initialize` response and upstream connection establishment
**Prevention:**
- Separate gateway-native capabilities (always available) from upstream-dependent capabilities (available after upstream connection).
- Option A: Block the `initialize` response until all upstream connections are established (adds latency but guarantees correctness).
- Option B: Return only gateway-native capabilities in `initialize`, then emit `tools/list_changed` once upstream tools are discovered (more complex but lower latency).
- Document which approach is chosen and why.
**Phase:** Phase 1 (upstream session lifecycle) and Phase 2 (tool discovery).
**Confidence:** HIGH - the MCP spec lifecycle section explicitly requires capabilities to be accurate.

### M4: Cross-Session Tool Cache Poisoning

**Severity:** MEDIUM
**What goes wrong:** The gateway caches upstream tool definitions globally (across sessions) to avoid re-fetching on every client connect. A compromised upstream poisons this cache with malicious tool definitions that affect all subsequent sessions.
**Why it happens:** Performance optimization (caching) conflicts with security (per-session freshness). If the cache is shared and the cache invalidation relies on upstream `tools/list_changed` (which a compromised server controls), the attacker controls cache state.
**Prevention:**
- Scope tool definition caches per upstream provider, not globally.
- Include a cache generation counter; on `tools/list_changed`, increment and fetch fresh definitions.
- Allow administrators to pin/freeze tool definitions so cache poisoning is detectable as a policy violation.
- Short cache TTL (minutes, not hours) so poisoned entries expire quickly even without explicit invalidation.
**Phase:** Phase 2 (tool discovery).
**Confidence:** MEDIUM - depends on whether caching is implemented (it will be for performance).

---

## Prevention Strategies by Phase

### Phase 1: Upstream Session Lifecycle

| Pitfall | Strategy | Priority |
|---------|----------|----------|
| S1 - Credential leakage | Extend redaction to upstream credential fields; boundary-level redaction tests | P0 |
| S2 - SSRF via upstream URLs | Reuse SSRFValidator on upstream connection path; DNS pinning | P0 |
| S6 - Stale credentials | Detect and propagate upstream 401/403; credential refresh mechanism | P1 |
| R1 - SSE lifecycle mismatch | Application-level heartbeats; explicit connection state machine | P0 |
| R2 - Cascading failure | Per-upstream timeouts; isolated request pipelines | P1 |
| R3 - Session memory leak | Session reaper; explicit upstream cleanup on session end | P0 |
| M1 - Protocol version mismatch | Record negotiated version; version-aware forwarding | P1 |
| M3 - Initialize handshake | Decide on blocking vs async capability reporting; implement consistently | P0 |

### Phase 2: Tool Discovery and Proxy

| Pitfall | Strategy | Priority |
|---------|----------|----------|
| S3 - Confused deputy | Immutable provider IDs for credential keying; audience validation | P0 |
| S4 - Tool poisoning | Tool definition pinning; description sanitization | P1 |
| M2 - Schema validation gap | Validate upstream inputSchema; size limits; $ref resolution | P1 |
| M4 - Cache poisoning | Per-provider cache scope; admin freeze capability | P2 |
| R4 - Notification storm | Debounce notifications; cache tools/list responses | P2 |

### Phase 3: Policy Enforcement

| Pitfall | Strategy | Priority |
|---------|----------|----------|
| S5 - Policy bypass | Strict tool name validation; gateway-controlled namespacing; NFC normalization | P0 |
| S4 - Tool poisoning (policy layer) | Policy gates on tool definition changes | P1 |

### Phase 4: Audit and Observability

| Pitfall | Strategy | Priority |
|---------|----------|----------|
| O1 - Audit log gaps | Write-ahead log; backpressure over drop; sequence numbers | P0 |
| O2 - Multi-hop debugging | OpenTelemetry spans per stage; trace ID in errors and audit | P0 |

### Phase 5: Deployment and Packaging

| Pitfall | Strategy | Priority |
|---------|----------|----------|
| O3 - Configuration drift | Config version hash; session affinity; file watcher reload | P1 |

---

## Sources

- [OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) - authoritative security risk taxonomy for MCP
- [Invariant Labs - MCP Tool Poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) - PoC for tool description manipulation
- [ETDI: Mitigating Tool Squatting and Rug Pull Attacks](https://arxiv.org/html/2506.01333v1) - academic treatment of tool integrity
- [Docker - MCP Horror Stories: CVE-2025-49596](https://www.docker.com/blog/mpc-horror-stories-cve-2025-49596-local-host-breach/) - real-world MCP proxy RCE
- [MCP Security 2026: 30 CVEs in 60 Days](https://www.heyuan110.com/posts/ai/2026-03-10-mcp-security-2026/) - CVE survey
- [Adversa AI - Top 25 MCP Vulnerabilities](https://adversa.ai/mcp-security-top-25-mcp-vulnerabilities/) - vulnerability taxonomy
- [MCP Spec 2025-03-26 - Lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle) - session lifecycle requirements
- [MCP Spec - Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) - official security guidance
- [LibreChat #11868](https://github.com/danny-avila/LibreChat/issues/11868) - SSE reconnection bug in real MCP implementation
- [MCP Discussion #102](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/102) - session state and long-lived connections
- [CyberArk - Poison Everywhere](https://www.cyberark.com/resources/threat-research-blog/poison-everywhere-no-output-from-your-mcp-server-is-safe) - output poisoning research
- [Elastic Security Labs - MCP Attack Vectors](https://www.elastic.co/security-labs/mcp-tools-attack-defense-recommendations) - defense recommendations
- [Solo.io - MCP and A2A Attack Vectors](https://www.solo.io/blog/deep-dive-mcp-and-a2a-attack-vectors-for-ai-agents) - gateway-specific attack analysis
- Codebase review: `src/auth/auth-redaction.ts`, `src/security/ssrf-validator.ts`, `src/profile/upstream-mcp-config.ts`, `src/transport/http-transport.ts`, `src/tooling/proxy-executor.ts`
