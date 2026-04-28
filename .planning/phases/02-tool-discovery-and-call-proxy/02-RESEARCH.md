# Phase 2: Tool Discovery and Call Proxy - Research

**Researched:** 2026-03-30
**Domain:** MCP proxy - tool list/call forwarding, sanitization, notification relay
**Confidence:** HIGH

## Summary

Phase 2 wires the gateway's core proxy behavior: forwarding `tools/list` and `tools/call` requests from downstream MCP clients to the upstream MCP server, sanitizing upstream tool metadata before forwarding, and relaying `tools/list_changed` notifications downstream with bounded queuing for disconnected clients.

The codebase already has all foundational infrastructure from Phase 1: `UpstreamConnectionManager` with `getOrConnect()` returning an MCP `Client` that exposes `listTools()` and `callTool()`, typed upstream errors (`UpstreamConnectionError`, `UpstreamTimeoutError`, `UpstreamAuthError`), session-scoped connection lifecycle, and SSE transport with message replay. The MCP SDK Server class exposes `sendToolListChanged()` which sends the notification through the downstream transport. The MCP SDK Client class supports `listChanged` handlers via `setNotificationHandler()` or the `listChanged` constructor option.

**Primary recommendation:** Add upstream branching at the two existing handler integration points (`handleOtherRequest` for `tools/list` at line 1804 and `handleToolCall` at line 1448), create a `ToolSanitizer` module for SEC-01, and wire a `tools/list_changed` notification listener on the upstream client that calls `server.sendToolListChanged()` downstream with bounded queue buffering when no SSE stream is active.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** When `upstream_mcp` is set in a profile, `tools/list` returns ONLY tools fetched from the upstream MCP server. Profile-defined OpenAPI tools are not included.
- **D-02:** A profile with both `upstream_mcp` AND `tools[]` defined is a validation error at profile load time - these are mutually exclusive. Fail early with a clear error message rather than silently dropping tools.
- **D-03:** Tool names allowlist: alphanumeric characters, underscore, and dash only (`[a-zA-Z0-9_-]`). Matches MCP spec identifier convention.
- **D-04:** Tool descriptions allowlist: printable ASCII, excluding angle brackets (`<`, `>`) and backticks (`` ` ``). Blocks HTML injection, script tags, and template injection while preserving human-readable text.
- **D-05:** Sanitization failure behavior: log a warning and drop only the offending tool. Do NOT reject the entire tools/list response. The downstream client receives the safe tools; the operator sees the warning in logs. One poisoned upstream tool must not break all tool discovery for the session.
- **D-06:** Forward `tools/list_changed` upstream notifications to the downstream SSE client. Scope is `tools/list_changed` only for this phase.
- **D-07:** Notification forwarding code is designed for extension - the dispatch path must support other notification types (resources, prompts) without structural changes. Just `tools/list_changed` is wired now; others are added later per phase.
- **D-08:** When no downstream SSE stream is attached, buffer notifications in a bounded queue. Queue is capped by both size (max ~50 events) and TTL (max ~5 min). Notifications that exceed either limit are dropped, not held. Replayed in order on reconnect.

### Claude's Discretion
- Exact queue size and TTL constants (ballpark: 50 events, 5min) - tune to reasonable defaults, configurable via profile or environment variable if easy to expose.
- MCP error code mapping for upstream failure cases (PROXY-04) - use existing typed errors and map to appropriate MCP error codes per spec.
- Where to locate the notification queue: session-scoped alongside UpstreamConnectionManager or as a separate per-session struct in http-transport - planner decides based on code layout.

### Deferred Ideas (OUT OF SCOPE)
- Tool namespacing (prefix upstream tool names with provider name)
- Forwarding non-tools notifications (resources/list_changed, prompts/list_changed)
- Per-notification-type queue TTL tuning
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROXY-03 | tools/list returns tools fetched from upstream MCP server | Upstream Client API `listTools()` confirmed on SDK v1.27.1; handler integration point at `handleOtherRequest` line 1804 with sessionId available |
| PROXY-04 | tools/call routed to upstream with typed error mapping | Upstream Client API `callTool()` confirmed; existing typed errors in `upstream-errors.ts`; MCP ErrorCode enum available for mapping |
| SEC-01 | Tool definitions sanitized before forwarding downstream | Regex-based allowlists for name (`[a-zA-Z0-9_-]`) and description (printable ASCII minus `<>` backtick); drop-and-warn per D-05 |
| REL-04 | tools/list_changed forwarded to downstream SSE with queue/replay | SDK Client `setNotificationHandler(ToolListChangedNotificationSchema)` for upstream; SDK Server `sendToolListChanged()` for downstream; existing SSE `sendToClient()` + replay infrastructure |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Use typed errors from `src/core/errors.ts` or `src/upstream/upstream-errors.ts` - never ad-hoc strings
- All new typed errors go through `sanitizeAuthErrorMessage()` for credential redaction
- Schema changes require `npm run generate-schemas` after any `src/types/profile.ts` modification
- Run `npm run typecheck` before finishing work
- Co-locate unit tests with source: `src/**/*.test.ts`
- Update CHANGELOG.md for non-minimal changes
- Prefer data-oriented programming over chained if/else
- Senior delivery standard: modular design, clean boundaries, tests for success and failure paths

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @modelcontextprotocol/sdk | 1.27.1 | MCP Client (`listTools`, `callTool`, notification handlers) and Server (`sendToolListChanged`) APIs | Already installed; source of truth for MCP protocol |
| vitest | 4.0.18 | Test framework | Already configured in project |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| (none new) | - | - | All dependencies already installed |

**No new dependencies required.** Phase 2 uses only the existing MCP SDK Client/Server APIs and project infrastructure.

## Architecture Patterns

### Recommended Project Structure
```
src/
  upstream/
    upstream-connection-manager.ts   # Existing - add notification listener wiring
    upstream-errors.ts               # Existing - already has typed errors
    upstream-tool-sanitizer.ts       # NEW - SEC-01 sanitization logic
    upstream-tool-sanitizer.test.ts  # NEW - sanitizer tests
    upstream-notification-queue.ts   # NEW - bounded notification buffer
    upstream-notification-queue.test.ts # NEW - queue tests
  mcp/
    mcp-server.ts                    # MODIFY - upstream branching in handlers
  profile/
    profile-loader.ts                # MODIFY - mutual-exclusivity validation (D-02)
    upstream-mcp-config.ts           # Existing - already validates upstream config
  types/
    profile.ts                       # May need minor additions
```

### Pattern 1: Upstream Branch in Handler
**What:** When `upstream_mcp` is configured in the profile, the `tools/list` and `tools/call` handlers branch to call the upstream MCP Client instead of using local profile tools.
**When to use:** Every `tools/list` and `tools/call` request when profile has `upstream_mcp` set.
**Key insight:** The branching condition is `profile.upstream_mcp` presence. The `handleOtherRequest` method (line 1804) already has `sessionId` available. The `handleToolCall` method (line 1448) also has `sessionId`.

**Integration point for tools/list (handleOtherRequest, line 1804):**
```typescript
if (req.method === 'tools/list') {
  // NEW: upstream branch
  if (this.profile?.upstream_mcp?.length) {
    return this.handleUpstreamToolsList(req, sessionId, profileId);
  }
  // Existing local tools logic...
}
```

**Integration point for tools/call (handleToolCall, line 1448):**
```typescript
// NEW: upstream branch - before local tool lookup
if (this.profile?.upstream_mcp?.length) {
  return this.handleUpstreamToolCall(req, sessionId, profileId);
}
// Existing local tool logic...
```

### Pattern 2: Tool Sanitizer (Data-Driven)
**What:** A stateless module that validates upstream tool metadata against allowlists before forwarding downstream.
**When to use:** Every `tools/list` response from upstream before forwarding.
**Design:**
```typescript
// Data-driven sanitization rules
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const TOOL_DESCRIPTION_FORBIDDEN = /[<>`]/;

interface SanitizationResult {
  tools: Tool[];         // Safe tools to forward
  dropped: DroppedTool[]; // Tools that failed sanitization (for logging)
}
```

### Pattern 3: Notification Dispatch Map (Extensible)
**What:** A map from notification method string to handler function, so adding new notification types is a one-liner.
**When to use:** When wiring upstream notification handlers on the MCP Client.
**Design:**
```typescript
// Data-driven dispatch - extensible per D-07
const NOTIFICATION_HANDLERS: Record<string, (server: Server) => void> = {
  'notifications/tools/list_changed': (server) => server.sendToolListChanged(),
  // Future: 'notifications/resources/list_changed': (server) => server.sendResourceListChanged(),
};
```

### Pattern 4: Bounded Notification Queue
**What:** A session-scoped queue that buffers upstream notifications when no downstream SSE stream is active, with size and TTL eviction.
**When to use:** When forwarding upstream notifications to disconnected downstream clients.
**Design:**
```typescript
interface NotificationQueueEntry {
  method: string;     // e.g. 'notifications/tools/list_changed'
  timestamp: number;
  params?: unknown;
}

class NotificationQueue {
  private readonly maxSize: number;   // default: 50
  private readonly ttlMs: number;     // default: 300_000 (5 min)
  private entries: NotificationQueueEntry[] = [];

  push(entry: NotificationQueueEntry): void { /* evict expired + overflow */ }
  drain(): NotificationQueueEntry[] { /* return all, clear */ }
}
```

### Anti-Patterns to Avoid
- **Hardcoded notification type checks:** Use dispatch map, not `if (method === 'tools/list_changed')` chains. D-07 requires extensibility.
- **Calling upstream on every tools/list without caching consideration:** For now no caching is required (upstream tools change via notifications), but design should not preclude a cache layer later.
- **Accessing UpstreamConnectionManager directly from MCP server:** Thread it through HttpTransport or a callback - the MCP server should not import transport internals directly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP Client tools API | Custom HTTP calls to upstream | `client.listTools()` / `client.callTool()` from SDK | SDK handles protocol framing, JSON-RPC, and error shapes |
| Downstream notification sending | Manual SSE event writing | `server.sendToolListChanged()` from SDK Server | SDK handles notification serialization and transport |
| Upstream notification listening | Manual SSE event parsing | `client.setNotificationHandler(ToolListChangedNotificationSchema, ...)` | SDK handles notification deserialization |
| MCP error codes | Custom error code numbers | `ErrorCode` enum from SDK types | Spec-defined codes, forward-compatible |

## Common Pitfalls

### Pitfall 1: Missing listChanged Capability Advertisement
**What goes wrong:** Downstream clients never receive `tools/list_changed` notifications even though the gateway sends them.
**Why it happens:** The gateway's `capabilities` in the initialize response currently declares `tools: {}` (line 1408-1421 in mcp-server.ts). Without `tools: { listChanged: true }`, clients may not subscribe to the notification.
**How to avoid:** When `upstream_mcp` is configured, set `tools: { listChanged: true }` in the capabilities response.
**Warning signs:** Downstream clients call `tools/list` repeatedly instead of reacting to notifications.

### Pitfall 2: Session-to-Upstream Client Resolution
**What goes wrong:** The `tools/list` and `tools/call` handlers in `mcp-server.ts` need an upstream MCP Client, but `UpstreamConnectionManager` lives on `HttpTransport`, not on `McpServer`.
**Why it happens:** Phase 1 wired the manager for credential validation only, not for request proxying.
**How to avoid:** Inject a callback or reference from HttpTransport to McpServer (similar to `setMessageHandler` pattern already used). Or expose `getUpstreamClient(sessionId, provider, token)` on a shared interface.
**Warning signs:** Circular dependency between mcp-server.ts and http-transport.ts.

### Pitfall 3: Upstream Client Not Connected Yet on tools/list
**What goes wrong:** First `tools/list` request triggers lazy upstream connection (PROXY-01 specifies lazy init on first tool use), adding latency to the first tools/list response.
**Why it happens:** `getOrConnect()` creates the connection on first call. The first `tools/list` IS the first tool use.
**How to avoid:** This is expected behavior per PROXY-01. Document that first `tools/list` may be slower. Ensure timeout handling is in place.
**Warning signs:** Timeout on first tools/list if upstream is slow to connect.

### Pitfall 4: Upstream callTool Error Shape Mismatch
**What goes wrong:** Upstream `callTool()` returns `isError: true` in the result (tool-level error) vs throwing an exception (protocol-level error). These are different failure modes.
**Why it happens:** MCP spec distinguishes tool execution errors (returned as `isError: true` content) from transport/protocol errors (JSON-RPC error responses).
**How to avoid:** Forward `isError: true` results as-is (they are valid tool responses). Only map thrown exceptions to MCP error codes.
**Warning signs:** All upstream tool errors become generic -32603 instead of being forwarded as tool results.

### Pitfall 5: Notification Queue Memory Leak
**What goes wrong:** If a session stays connected but SSE stream is not attached, notifications accumulate without bound.
**Why it happens:** Queue TTL eviction only runs on push, not on a timer.
**How to avoid:** Evict expired entries on every push. Queue size cap (50) provides hard limit. Session reaper (REL-02) already cleans up dead sessions.
**Warning signs:** Memory growth in long-lived sessions with frequent upstream tool changes.

### Pitfall 6: Mutual Exclusivity Validation Timing
**What goes wrong:** Profile with both `upstream_mcp` and `tools[]` is not rejected, leading to confusing behavior at runtime.
**Why it happens:** Validation is not added at profile load time.
**How to avoid:** Add validation in `profile-loader.ts` during the existing validation pass, before any server initialization. Check after `resolveUpstreamMcpConfig()` resolves the final config.
**Warning signs:** Profile loads successfully but tools/list returns empty or wrong tools.

## Code Examples

### Upstream tools/list forwarding
```typescript
// In mcp-server.ts handleOtherRequest, tools/list branch
private async handleUpstreamToolsList(
  req: Record<string, unknown>,
  sessionId: string | undefined,
  profileId: string | undefined,
): Promise<unknown> {
  const provider = this.profile!.upstream_mcp![0]; // single provider per profile
  const token = await this.getUpstreamToken(sessionId, profileId);
  const client = await this.getUpstreamClient(sessionId!, provider, token);

  const result = await client.listTools();
  const sanitized = sanitizeToolList(result.tools, this.logger);

  return {
    jsonrpc: '2.0',
    id: req.id,
    result: { tools: sanitized.tools },
  };
}
```

### Upstream tools/call forwarding
```typescript
// In mcp-server.ts handleToolCall, upstream branch
private async handleUpstreamToolCall(
  req: Record<string, unknown>,
  sessionId: string | undefined,
  profileId: string | undefined,
): Promise<unknown> {
  const params = req.params as Record<string, unknown>;
  const toolName = params.name as string;
  const args = (params.arguments as Record<string, unknown>) || {};

  const provider = this.profile!.upstream_mcp![0];
  const token = await this.getUpstreamToken(sessionId, profileId);
  const client = await this.getUpstreamClient(sessionId!, provider, token);

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return {
      jsonrpc: '2.0',
      id: req.id,
      result, // Forward as-is, including isError if present
    };
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: req.id,
      error: mapUpstreamErrorToMcpError(error, provider.name),
    };
  }
}
```

### Tool sanitizer
```typescript
// src/upstream/upstream-tool-sanitizer.ts
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DESCRIPTION_FORBIDDEN_CHARS = /[<>`]/;

export interface SanitizationResult {
  tools: Tool[];
  dropped: { name: string; reason: string }[];
}

export function sanitizeToolList(tools: Tool[], logger: Logger): SanitizationResult {
  const safe: Tool[] = [];
  const dropped: { name: string; reason: string }[] = [];

  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      dropped.push({ name: tool.name, reason: 'invalid characters in tool name' });
      continue;
    }
    if (tool.description && DESCRIPTION_FORBIDDEN_CHARS.test(tool.description)) {
      dropped.push({ name: tool.name, reason: 'forbidden characters in description' });
      continue;
    }
    safe.push(tool);
  }

  for (const d of dropped) {
    logger.warn('Dropped upstream tool due to sanitization failure', d);
  }

  return { tools: safe, dropped };
}
```

### Upstream error to MCP error mapping
```typescript
// Data-driven error mapping
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const UPSTREAM_ERROR_MAP: Record<string, { code: number; messagePrefix: string }> = {
  UpstreamConnectionError: { code: ErrorCode.InternalError, messagePrefix: 'Upstream connection failed' },
  UpstreamTimeoutError:    { code: ErrorCode.RequestTimeout, messagePrefix: 'Upstream request timed out' },
  UpstreamAuthError:       { code: ErrorCode.InternalError, messagePrefix: 'Upstream authentication failed' },
};

function mapUpstreamErrorToMcpError(error: unknown, providerName: string) {
  const err = error instanceof Error ? error : new Error(String(error));
  const mapping = UPSTREAM_ERROR_MAP[err.constructor.name] ?? {
    code: ErrorCode.InternalError,
    messagePrefix: 'Upstream error',
  };
  const correlationId = generateCorrelationId();
  return {
    code: mapping.code,
    message: `${mapping.messagePrefix} (provider: ${providerName}, correlation: ${correlationId})`,
    data: { correlationId, providerName },
  };
}
```

### Notification listener wiring
```typescript
// Wire on upstream client after connection
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

function wireUpstreamNotifications(
  upstreamClient: Client,
  notifyDownstream: (method: string) => void,
) {
  // Data-driven dispatch map (extensible per D-07)
  const handlers: Record<string, () => void> = {
    'notifications/tools/list_changed': () => notifyDownstream('tools/list_changed'),
  };

  upstreamClient.setNotificationHandler(
    ToolListChangedNotificationSchema,
    () => handlers['notifications/tools/list_changed']?.(),
  );
}
```

## MCP Error Code Mapping (Claude's Discretion)

Based on MCP SDK `ErrorCode` enum:

| Upstream Error | MCP Error Code | Numeric | Rationale |
|---------------|---------------|---------|-----------|
| `UpstreamConnectionError` | `InternalError` | -32603 | Gateway internal failure, not client's fault |
| `UpstreamTimeoutError` | `RequestTimeout` | -32001 | Direct semantic match |
| `UpstreamAuthError` | `InternalError` | -32603 | Upstream auth is gateway's concern, not downstream client's |
| `UpstreamMalformedResponseError` | `InternalError` | -32603 | Bad upstream response, gateway should mask details |
| Tool-level `isError: true` | (not an error code) | N/A | Forward as tool result, not as JSON-RPC error |

## Notification Queue Location (Claude's Discretion)

**Recommendation: Session-scoped on UpstreamConnectionManager.**

Rationale:
- The notification listener is wired on the upstream `Client`, which is managed by `UpstreamConnectionManager`
- The queue lifetime matches connection lifetime (session-scoped)
- `UpstreamConnectionManager` already has a `Map<string, Map<string, UpstreamConnection>>` keyed by sessionId
- Adding a per-session queue alongside the connection map keeps the abstraction clean
- The MCP server receives a callback to flush the queue when a downstream SSE stream reconnects

Alternative considered: Queue on `HttpTransport` - rejected because it would couple transport details with upstream notification state.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run --reporter=verbose` |
| Full suite command | `npm test` (includes typecheck) |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROXY-03 | tools/list returns upstream tools | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream tools/list" -x` | No - Wave 0 |
| PROXY-03 | tools/list sanitizes before forwarding | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -x` | No - Wave 0 |
| PROXY-04 | tools/call forwards to upstream | unit | `npx vitest run src/mcp/mcp-server.test.ts -t "upstream tools/call" -x` | No - Wave 0 |
| PROXY-04 | upstream errors mapped to MCP errors | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "error mapping" -x` | No - Wave 0 |
| SEC-01 | tool name sanitization | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "name" -x` | No - Wave 0 |
| SEC-01 | tool description sanitization | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "description" -x` | No - Wave 0 |
| SEC-01 | poisoned tool dropped, safe tools kept | unit | `npx vitest run src/upstream/upstream-tool-sanitizer.test.ts -t "drop" -x` | No - Wave 0 |
| REL-04 | notification forwarded to downstream | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "forward" -x` | No - Wave 0 |
| REL-04 | notification queued when disconnected | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "queue" -x` | No - Wave 0 |
| REL-04 | queue eviction by size and TTL | unit | `npx vitest run src/upstream/upstream-notification-queue.test.ts -t "evict" -x` | No - Wave 0 |
| D-02 | mutual exclusivity validation | unit | `npx vitest run src/profile/profile-loader.test.ts -t "mutual exclusiv" -x` | No - Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/upstream/upstream-tool-sanitizer.ts` + `src/upstream/upstream-tool-sanitizer.test.ts` - covers SEC-01
- [ ] `src/upstream/upstream-notification-queue.ts` + `src/upstream/upstream-notification-queue.test.ts` - covers REL-04
- [ ] Tests for upstream branching in mcp-server.ts - covers PROXY-03, PROXY-04
- [ ] Tests for mutual exclusivity in profile-loader.ts - covers D-02

## Sources

### Primary (HIGH confidence)
- MCP SDK v1.27.1 source (`node_modules/@modelcontextprotocol/sdk/dist/esm/`) - Client `listTools()`, `callTool()`, `setNotificationHandler()`; Server `sendToolListChanged()`; ErrorCode enum
- `src/upstream/upstream-connection-manager.ts` - `getOrConnect()` API, connection lifecycle
- `src/upstream/upstream-errors.ts` - typed error classes, `toMcpErrorResponse()` helper
- `src/mcp/mcp-server.ts` - handler integration points at lines 1804 (tools/list) and 1448 (tools/call)
- `src/transport/http-transport.ts` - SSE `sendToClient()` with message queue and replay
- `src/types/http-transport.ts` - `SessionData`, `SSEStreamState`, `HttpProfileContext`

### Secondary (MEDIUM confidence)
- MCP specification 2025-03-26 transport docs referenced in codebase comments

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all libraries already installed and verified in node_modules
- Architecture: HIGH - integration points identified with line numbers in source
- Pitfalls: HIGH - derived from direct code reading of handler routing, capability advertisement, and connection lifecycle
- Error mapping: HIGH - ErrorCode enum values verified from SDK source

**Research date:** 2026-03-30
**Valid until:** 2026-04-30 (stable - MCP SDK version pinned, codebase patterns established)
