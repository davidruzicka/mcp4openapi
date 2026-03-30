# Phase 2: Tool Discovery and Call Proxy - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Forward tools/list and tools/call between downstream MCP clients and the single upstream MCP server
defined in the active profile. Sanitize upstream tool definitions before forwarding. Relay
tools/list_changed upstream notifications to downstream SSE clients with bounded queuing for
disconnected clients.

No aggregation across multiple providers. No tool namespacing (deferred). Profile-per-upstream
model: one upstream per profile.

</domain>

<decisions>
## Implementation Decisions

### Tool List Composition

- **D-01:** When `upstream_mcp` is set in a profile, `tools/list` returns ONLY tools fetched from the
  upstream MCP server. Profile-defined OpenAPI tools are not included.
- **D-02:** A profile with both `upstream_mcp` AND `tools[]` defined is a validation error at profile
  load time — these are mutually exclusive. Fail early with a clear error message rather than silently
  dropping tools.

### Tool Sanitization (SEC-01)

- **D-03:** Tool names allowlist: alphanumeric characters, underscore, and dash only (`[a-zA-Z0-9_-]`).
  Matches MCP spec identifier convention.
- **D-04:** Tool descriptions allowlist: printable ASCII, excluding angle brackets (`<`, `>`) and
  backticks (`` ` ``). Blocks HTML injection, script tags, and template injection while preserving
  human-readable text.
- **D-05:** Sanitization failure behavior: log a warning and drop only the offending tool. Do NOT
  reject the entire tools/list response. The downstream client receives the safe tools; the operator
  sees the warning in logs. One poisoned upstream tool must not break all tool discovery for the
  session.

### Notification Forwarding (REL-04)

- **D-06:** Forward `tools/list_changed` upstream notifications to the downstream SSE client. Scope
  is `tools/list_changed` only for this phase.
- **D-07:** Notification forwarding code is designed for extension — the dispatch path must support
  other notification types (resources, prompts) without structural changes. Just `tools/list_changed`
  is wired now; others are added later per phase.
- **D-08:** When no downstream SSE stream is attached, buffer notifications in a bounded queue.
  Queue is capped by both size (max ~50 events) and TTL (max ~5 min). Notifications that exceed
  either limit are dropped, not held. Replayed in order on reconnect.

### Claude's Discretion

- Exact queue size and TTL constants (ballpark: 50 events, 5min) — tune to reasonable defaults,
  configurable via profile or environment variable if easy to expose.
- MCP error code mapping for upstream failure cases (PROXY-04) — use existing typed errors
  (`UpstreamConnectionError`, `UpstreamTimeoutError`, `UpstreamAuthError`) and map to appropriate
  MCP error codes per spec.
- Where to locate the notification queue: session-scoped alongside UpstreamConnectionManager or
  as a separate per-session struct in http-transport — planner decides based on code layout.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Profile Types and Schema
- `src/types/profile.ts` — `UpstreamMcpServerConfig` and profile type definitions; source of truth
  for profile structure including `upstream_mcp` field
- `src/generated-schemas.ts` — Zod runtime schemas (auto-generated); must stay in sync after any
  type change

### Upstream Connection Infrastructure
- `src/upstream/upstream-connection-manager.ts` — `getOrConnect()`, `validateCredentials()`,
  per-session lifecycle; the MCP `Client` returned here is what phase 2 calls `listTools()` and
  `callTool()` on
- `src/upstream/upstream-errors.ts` — `UpstreamConnectionError`, `UpstreamTimeoutError`,
  `UpstreamAuthError`; use these for typed error mapping in PROXY-04

### MCP Server Handlers (integration points)
- `src/mcp/mcp-server.ts` — `ListToolsRequestSchema` handler (line ~789) and
  `CallToolRequestSchema` handler (line ~857); these are the integration points for upstream
  branching; sessionId is already threaded in via the message handler
- `src/core/errors.ts` — error taxonomy; use typed errors, never ad-hoc strings

### Architecture and Transport
- `IMPLEMENTATION.md` — system-wide architecture decisions
- `docs/HTTP-TRANSPORT.md` — SSE session model, replay infrastructure (relevant for REL-04 queue
  and replay on reconnect)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `UpstreamConnectionManager.getOrConnect(sessionId, provider, token)` — returns a connected MCP
  `Client`; phase 2 calls `.listTools()` and `.callTool()` on the returned client
- `src/upstream/upstream-credential-store.ts` `buildAuthHeaders()` — already used internally by
  connection manager; not needed directly in phase 2
- Existing SSE session infrastructure in `src/transport/http-transport.ts` — SSE stream and session
  state per profileId+sessionId; REL-04 queue hangs off this session state

### Established Patterns
- ListTools handler returns `{ tools }` — upstream branch merges into same response shape
- CallTool handler dispatches on `toolDef` from `profile.tools` — upstream branch bypasses
  profile.tools entirely, calls upstream client directly
- All new typed errors go in `src/core/errors.ts` or the upstream errors file; never ad-hoc strings
- Schema changes require `npm run generate-schemas` to regenerate Zod + JSON Schema

### Integration Points
- `mcp-server.ts` `ListToolsRequestSchema` and `CallToolRequestSchema` handlers — upstream
  branching added here; presence of `upstream_mcp` in profile is the branch condition
- `src/profile/profile-loader.ts` — add mutual-exclusivity validation (D-02) here at profile load
- `HttpProfileContext.upstreamMcp` populated at `mcp-server.ts:658` — available to handlers
  without re-reading profile

</code_context>

<specifics>
## Specific Ideas

- Notification forwarding architecture must be extensible (D-07): treat notification type as a
  dispatch key, not a hardcoded condition — so adding `resources/list_changed` later is a one-liner.
- Bounded notification queue (D-08): model it as a simple array with eviction on push when
  size > max or entries older than TTL. No complex data structure needed.

</specifics>

<deferred>
## Deferred Ideas

- Tool namespacing (prefix upstream tool names with provider name) — explicitly out of scope for
  this phase per REQUIREMENTS.md Out of Scope section
- Forwarding non-tools notifications (resources/list_changed, prompts/list_changed) — architecture
  supports it, wiring deferred to a later phase
- Per-notification-type queue TTL tuning — single TTL covers phase 2 needs

</deferred>

---

*Phase: 02-tool-discovery-and-call-proxy*
*Context gathered: 2026-03-30*
