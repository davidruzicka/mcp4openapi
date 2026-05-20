# Phase 1: Upstream Session Foundation - Research

**Researched:** 2026-03-26
**Domain:** MCP client-side SDK usage, upstream session lifecycle, credential pass-through, session reaping
**Confidence:** HIGH

## Summary

Phase 1 establishes the foundation for the gateway's upstream connectivity. A downstream client session must be able to lazily connect to an upstream HTTP MCP server on first tool use, forward client-supplied credentials, handle upstream failures with typed errors and correlation IDs, and clean up connections when sessions expire or disconnect.

The MCP SDK (currently 1.27.1, target 1.28.0) provides `Client` and `StreamableHTTPClientTransport` as first-class APIs. `Client.connect(transport)` performs the initialize handshake automatically. `StreamableHTTPClientTransport` handles SSE reconnection with configurable backoff, session ID tracking, and `Last-Event-ID` resumability. The gateway creates one `Client` + `StreamableHTTPClientTransport` pair per downstream session per upstream provider. Credentials are injected via `requestInit.headers` on the transport constructor - no custom fetch needed for bearer/custom-header auth.

The existing codebase provides strong foundations: `SessionData` type with `lastActivityAt` for reaping, `destroySession()` with SSE cleanup, `PROXY_CREDENTIALS` constant pattern, `auth-redaction.ts` with `SECRET_FIELD_NAMES` set, typed error hierarchy with correlation IDs, and `SSRFValidator` for URL validation. The work is primarily additive - new modules that integrate with existing session lifecycle hooks.

**Primary recommendation:** Build an `UpstreamConnectionManager` class that owns the per-session upstream `Client` instances, exposes lazy `getOrConnect(sessionId, providerName)` and `closeAll(sessionId)` methods, and integrates with the existing session reaper via `destroySession()` extension.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PROXY-01 | Lazy upstream connection on first tool use | MCP SDK `Client.connect()` + `StreamableHTTPClientTransport` constructor. Lazy instantiation via `getOrConnect()` pattern. Transport `requestInit.headers` for auth injection. |
| PROXY-02 | Client-supplied upstream credentials forwarded, never logged | `StreamableHTTPClientTransport` `requestInit.headers` for bearer/custom-header. Extend `SECRET_FIELD_NAMES` in `auth-redaction.ts`. Store credentials in session memory only. |
| REL-01 | App-level heartbeat pings on upstream SSE connections | `Client.ping()` method available. Configurable interval timer per upstream connection. `StreamableHTTPClientTransport.onerror` callback for failure detection. |
| REL-02 | Session reaper closes inactive sessions + upstream connections | Extend existing `destroySession()` in `http-transport.ts` to call `UpstreamConnectionManager.closeAll(sessionId)`. Existing reaper interval and `sessionTimeoutMs` config. |
| REL-03 | Typed error responses with correlation IDs, no credential leaks | New error types: `UpstreamConnectionError`, `UpstreamTimeoutError`, `UpstreamAuthError`. Extend `sanitizeAuthErrorMessage()` for upstream credentials. Existing `generateCorrelationId()`. |
| SEC-02 | Upstream credentials redacted from all logs/errors/diagnostics | Extend `SECRET_FIELD_NAMES` set with upstream credential field names. Add upstream-aware patterns to `sanitizeAuthErrorMessage()`. Boundary-level redaction tests. |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Use typed errors from `src/core/errors.ts` - never ad-hoc error strings
- All errors include correlation IDs
- Sanitize tokens and secrets in error messages
- Run `npm run typecheck` before finishing work
- Update CHANGELOG.md for more than minimal changes
- Each new validator must have both success and failure tests
- Prefer data-oriented programming over chained if/else
- Senior delivery standard: modular design, explicit boundaries, production quality
- Schema synchronization: TypeScript types -> Zod schemas -> JSON Schema must stay in sync
- Test-driven development preferred
- Never disable existing tests without explicit permission

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | 1.28.0 (upgrade from 1.27.1) | `Client` + `StreamableHTTPClientTransport` for upstream connections | Already a dependency. Client class handles initialize handshake, tool calls, pings. Transport handles SSE, reconnection, session IDs. |

### Supporting (Already Present)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | existing | Validate upstream connection config, session state schemas | Runtime validation of upstream config and connection state |
| `express` | 5.2.1 | HTTP transport middleware | Existing - no changes needed for Phase 1 |
| `prom-client` | existing | Metrics for upstream connections | Add gauges for active upstream connections, connection errors |

### No New Dependencies

Phase 1 requires only the MCP SDK upgrade. No new packages needed.

**Installation:**
```bash
npm install @modelcontextprotocol/sdk@^1.28.0
```

**Version verification:** npm registry confirms 1.28.0 is the current latest version.

## Architecture Patterns

### Recommended Project Structure

```
src/
  upstream/                        # NEW - upstream connection management
    upstream-connection-manager.ts # Core: lazy connect, close, getOrConnect
    upstream-connection-state.ts   # Connection state machine (IDLE/CONNECTING/CONNECTED/RECONNECTING/FAILED)
    upstream-heartbeat.ts          # App-level ping timer per connection
    upstream-errors.ts             # Typed errors for upstream failures
    upstream-credential-store.ts   # Per-session credential extraction and storage
    upstream-connection-manager.test.ts
    upstream-heartbeat.test.ts
    upstream-errors.test.ts
    upstream-credential-store.test.ts
  auth/
    auth-redaction.ts              # MODIFY - extend SECRET_FIELD_NAMES
  types/
    http-transport.ts              # MODIFY - extend SessionData
    upstream-connection.ts         # NEW - connection state types
  transport/
    http-transport.ts              # MODIFY - integrate with destroySession, session reaper
  core/
    errors.ts                      # MODIFY - add upstream error types
```

### Pattern 1: Lazy Connection via getOrConnect

**What:** Upstream connections are not created at session init. On first tool use, `UpstreamConnectionManager.getOrConnect(sessionId, providerName)` creates and caches the connection.

**When to use:** Every tool call or tools/list that targets an upstream provider.

**Example:**
```typescript
// Source: MCP SDK Client API (verified from installed SDK types)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

class UpstreamConnectionManager {
  private connections = new Map<string, Map<string, UpstreamConnection>>();

  async getOrConnect(
    sessionId: string,
    provider: UpstreamMcpServerConfig,
    credentials: UpstreamCredentials,
  ): Promise<Client> {
    const key = `${sessionId}:${provider.name}`;
    const existing = this.connections.get(sessionId)?.get(provider.name);
    if (existing?.state === 'CONNECTED') {
      return existing.client;
    }

    const transport = new StreamableHTTPClientTransport(
      new URL(provider.transport.url),
      {
        requestInit: {
          headers: buildAuthHeaders(provider, credentials),
        },
        reconnectionOptions: {
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 30000,
          reconnectionDelayGrowFactor: 1.5,
          maxRetries: 2,
        },
      },
    );

    const client = new Client(
      { name: 'mcp4openapi-gateway', version: '0.5.7' },
      { capabilities: {} },
    );

    transport.onerror = (error) => this.handleTransportError(sessionId, provider.name, error);
    transport.onclose = () => this.handleTransportClose(sessionId, provider.name);

    await client.connect(transport);

    this.storeConnection(sessionId, provider.name, { client, transport, state: 'CONNECTED' });
    return client;
  }

  async closeAll(sessionId: string): Promise<void> {
    const sessionConns = this.connections.get(sessionId);
    if (!sessionConns) return;
    for (const [, conn] of sessionConns) {
      await conn.transport.close().catch(() => {});
    }
    this.connections.delete(sessionId);
  }
}
```

### Pattern 2: Connection State Machine

**What:** Each upstream connection tracks its state explicitly: `IDLE` -> `CONNECTING` -> `CONNECTED` -> `RECONNECTING` -> `FAILED`.

**When to use:** All connection lifecycle decisions (can we send? should we reconnect? is this connection healthy?).

```typescript
type UpstreamConnectionState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'FAILED';

interface UpstreamConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  state: UpstreamConnectionState;
  providerName: string;
  connectedAt?: number;
  lastActivityAt: number;
  lastError?: Error;
  heartbeatTimer?: NodeJS.Timeout;
}
```

### Pattern 3: Credential Injection via requestInit

**What:** Upstream credentials are injected at transport construction via `requestInit.headers`. No custom fetch override needed.

**When to use:** Bearer token and custom-header auth types.

```typescript
function buildAuthHeaders(
  provider: UpstreamMcpServerConfig,
  credentials: UpstreamCredentials,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!provider.auth) return headers;

  const token = credentials.getToken(provider.name);
  if (!token) return headers;

  switch (provider.auth.type) {
    case 'bearer':
      headers['Authorization'] = `Bearer ${token}`;
      break;
    case 'custom-header':
      if (provider.auth.header_name) {
        headers[provider.auth.header_name] = token;
      }
      break;
    // query auth handled separately via URL manipulation
  }
  return headers;
}
```

### Pattern 4: Session Reaper Extension

**What:** The existing `destroySession()` method in `http-transport.ts` is extended to call `UpstreamConnectionManager.closeAll(sessionId)` before deleting session state.

**When to use:** Session expiry (reaper interval) and explicit session termination (DELETE /mcp).

### Anti-Patterns to Avoid

- **God session object:** Do NOT store `Client` instances directly in `SessionData`. `SessionData` holds session metadata; `UpstreamConnectionManager` owns connections, indexed by session ID. Clean lifecycle separation.
- **Eager connection:** Do NOT connect to upstream during `initialize` request. Connect lazily on first tool use.
- **Shared credentials across sessions:** Each session has its own credential store. Never share credentials between sessions.
- **Retry on upstream 401:** Do NOT retry with the same expired token. Propagate the auth failure to the downstream client immediately.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP protocol framing | Custom JSON-RPC + SSE client | `@modelcontextprotocol/sdk` Client + StreamableHTTPClientTransport | Protocol versioning, session ID management, SSE reconnection, `Last-Event-ID` resumability all handled by SDK |
| SSE reconnection with backoff | Custom EventSource + retry logic | `StreamableHTTPClientTransport.reconnectionOptions` | SDK implements configurable exponential backoff with max retries |
| Session ID tracking | Custom header management | `StreamableHTTPClientTransport.sessionId` property | SDK auto-reads `Mcp-Session-Id` from server response and includes it in subsequent requests |
| Correlation IDs | Custom UUID generation | Existing `generateCorrelationId()` | Already in the codebase, used by all error types |
| Token redaction | Custom regex for each error path | Extend existing `auth-redaction.ts` | Centralized redaction with `SECRET_FIELD_NAMES` set + `sanitizeAuthErrorMessage()` |
| URL validation | Custom URL parsing + IP checks | Existing `SSRFValidator` | Handles private IP blocking, cloud metadata endpoint blocking, protocol enforcement |

## Common Pitfalls

### Pitfall 1: Credential Leakage Through Transport Errors

**What goes wrong:** `StreamableHTTPClientTransport` error events may include the full request headers (including auth tokens) in the error object's message or stack trace.
**Why it happens:** The SDK's error class `StreamableHTTPError` includes the response message but the underlying `fetch` error may contain request context.
**How to avoid:** Wrap all transport `onerror` callbacks with redaction. Never log raw transport errors. Always pass through `sanitizeAuthErrorMessage()` before logging or returning to client.
**Warning signs:** Error messages containing `Bearer` or JWT-pattern strings in test output.

### Pitfall 2: Zombie Upstream Connections After Session Timeout

**What goes wrong:** Session reaper deletes `SessionData` from the sessions Map but forgets to close upstream connections. The `Client` instances remain in the `UpstreamConnectionManager` with active SSE listeners, leaking memory and file descriptors.
**Why it happens:** `UpstreamConnectionManager` is a separate component from session management. If the integration point (calling `closeAll()` from `destroySession()`) is missed, connections leak.
**How to avoid:** Add a listener/callback pattern: `UpstreamConnectionManager` registers a `onSessionDestroyed` callback with the transport. The transport calls it during `destroySession()`. Verify with a test that creates a session, establishes upstream connection, lets the session expire, and asserts the upstream connection is closed.
**Warning signs:** Active upstream connection count in metrics grows monotonically over time.

### Pitfall 3: Race Condition on Concurrent getOrConnect

**What goes wrong:** Two simultaneous tool calls for the same upstream provider trigger two `getOrConnect()` calls. Both see no existing connection and both create a new `Client`. One connection is orphaned.
**Why it happens:** `Client.connect()` is async. Without a lock or pending-connection tracking, concurrent callers create duplicates.
**How to avoid:** Track in-flight connection promises. If a connection for `sessionId:providerName` is already being established, return the existing promise instead of creating a new one.
**Warning signs:** Multiple "upstream connected" log entries for the same session+provider.

### Pitfall 4: SSE Silent Disconnect Without Heartbeat

**What goes wrong:** Upstream SSE connection drops silently (intermediate proxy closes idle connection). The gateway does not detect the failure until the next tool call attempt, which then fails with a confusing error.
**Why it happens:** TCP keepalive has long timeouts (minutes). Intermediate proxies (nginx, cloud load balancers) may close idle SSE connections after 60-120 seconds without notifying the application layer.
**How to avoid:** Implement an application-level heartbeat using `Client.ping()` at configurable intervals (default 30s). On ping failure, transition the connection state to RECONNECTING or FAILED and emit a warning metric.
**Warning signs:** Upstream tool calls failing with "connection closed" errors after periods of inactivity.

### Pitfall 5: auth-redaction.ts SECRET_FIELD_NAMES Is Incomplete for Upstream

**What goes wrong:** The existing `SECRET_FIELD_NAMES` set covers OAuth fields (`assertion`, `subject_token`, `access_token`, `refresh_token`, `authorization`) but NOT upstream-specific field names that will be introduced (e.g., `upstream_token`, `x-api-key` header values stored in session).
**Why it happens:** The redaction was designed for the OAuth interceptor use case, not the upstream credential pass-through use case.
**How to avoid:** Extend `SECRET_FIELD_NAMES` with upstream credential field names. Also ensure that any object containing upstream credentials uses the `redactAuthPayload()` function before logging.
**Warning signs:** `grep -r "Bearer\|x-api-key" *.log` returns matches outside test files.

## Code Examples

### Creating an Upstream MCP Client Connection

```typescript
// Source: MCP SDK installed types (verified from node_modules)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('https://upstream-mcp.example.com/mcp'),
  {
    requestInit: {
      headers: { 'Authorization': 'Bearer <token>' },
    },
    reconnectionOptions: {
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 30000,
      reconnectionDelayGrowFactor: 1.5,
      maxRetries: 2,
    },
  },
);

const client = new Client(
  { name: 'mcp4openapi-gateway', version: '0.5.7' },
  { capabilities: {} },
);

// connect() performs MCP initialize handshake automatically
await client.connect(transport);

// Server capabilities available after connect
const caps = client.getServerCapabilities();
const version = client.getServerVersion();
```

### Application-Level Heartbeat

```typescript
// Source: MCP SDK Client.ping() (verified from installed SDK types)
function startHeartbeat(
  client: Client,
  intervalMs: number,
  onFailure: (error: Error) => void,
): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      await client.ping({ timeout: 5000 });
    } catch (error) {
      onFailure(error instanceof Error ? error : new Error(String(error)));
    }
  }, intervalMs);
}
```

### New Typed Errors for Upstream Failures

```typescript
// Follows existing pattern from src/core/errors.ts
export class UpstreamConnectionError extends MCPError {
  constructor(message: string, providerName: string, details?: Record<string, unknown>) {
    super(message, 'UPSTREAM_CONNECTION_ERROR', { providerName, ...details });
    this.name = 'UpstreamConnectionError';
  }
}

export class UpstreamTimeoutError extends MCPError {
  constructor(providerName: string, timeoutMs: number) {
    super(
      `Upstream provider '${providerName}' timed out after ${timeoutMs}ms`,
      'UPSTREAM_TIMEOUT',
      { providerName, timeoutMs },
    );
    this.name = 'UpstreamTimeoutError';
  }
}

export class UpstreamAuthError extends MCPError {
  constructor(providerName: string) {
    super(
      `Upstream provider '${providerName}' rejected credentials`,
      'UPSTREAM_AUTH_ERROR',
      { providerName },
    );
    this.name = 'UpstreamAuthError';
  }
}
```

### Extending SessionData for Upstream Credentials

```typescript
// Extend existing SessionData in src/types/http-transport.ts
export interface SessionData {
  // ... existing fields ...

  /** Upstream credentials extracted from client request, stored per-provider */
  upstreamCredentials?: Map<string, string>;
}
```

### Extending Auth Redaction

```typescript
// Extend SECRET_FIELD_NAMES in src/auth/auth-redaction.ts
const SECRET_FIELD_NAMES = new Set([
  'assertion',
  'subject_token',
  'access_token',
  'refresh_token',
  'authorization',
  // Upstream credential fields
  'upstream_token',
  'upstream_credentials',
  'x-api-key',
  'api_key',
]);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom SSE + JSON-RPC client | MCP SDK `Client` + `StreamableHTTPClientTransport` | SDK 1.0.0 (2025) | No need to hand-roll MCP protocol framing |
| SSE-only transport | Streamable HTTP (POST for requests, GET SSE for notifications) | MCP Spec 2025-03-26 | Bidirectional communication without WebSocket |
| No reconnection support | Built-in exponential backoff reconnection | SDK ~1.10+ | `reconnectionOptions` on transport constructor |
| Manual session ID tracking | Automatic `Mcp-Session-Id` management | MCP Spec 2025-03-26 | Transport reads/writes session header automatically |

## Open Questions

1. **Credential delivery mechanism from downstream client**
   - What we know: Requirements say "provided at session initialization" and the architecture research mentions "custom header or init params"
   - What's unclear: Exact mechanism - custom HTTP header (e.g., `X-Upstream-Credentials`) vs MCP initialize params
   - Recommendation: Use a custom HTTP header (`X-Upstream-Token` or similar) since MCP init params are protocol-level and modifying them would create non-standard MCP. This keeps credential delivery at the transport layer. The planner should lock this decision.

2. **Query-type auth for upstream providers**
   - What we know: `UpstreamMcpAuthConfig` supports `type: 'query'` with `query_param`
   - What's unclear: `StreamableHTTPClientTransport` takes a URL; query params can be appended to the URL at construction time, but the SDK may strip/modify query params
   - Recommendation: Append query param to the URL before passing to transport constructor. Verify in integration test.

3. **Multiple upstream providers per session**
   - What we know: Profile can have multiple `upstream_mcp` providers. Architecture says "profile-per-upstream model"
   - What's unclear: Phase 1 scope - do we support multiple providers per session or just one?
   - Recommendation: Build for multiple (the data structures support it via Map keyed by provider name) but Phase 1 testing can focus on single-provider scenarios. Phase 2 will exercise multi-provider.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime | Yes | v24.13.1 | - |
| npm | Package management | Yes | 11.8.0 | - |
| @modelcontextprotocol/sdk | Upstream MCP client | Yes (1.27.1 installed, 1.28.0 on npm) | 1.28.0 target | - |
| vitest | Testing | Yes | existing | - |

No missing dependencies.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (existing) |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run src/upstream/` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROXY-01a | Upstream connection NOT created at session init | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "lazy"` | No - Wave 0 |
| PROXY-01b | Upstream connection created on first tool use | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "getOrConnect"` | No - Wave 0 |
| PROXY-01c | Concurrent getOrConnect returns same promise (no duplicate connections) | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "concurrent"` | No - Wave 0 |
| PROXY-02a | Client-supplied Bearer token forwarded in upstream request headers | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "bearer"` | No - Wave 0 |
| PROXY-02b | Client-supplied custom-header token forwarded correctly | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "custom-header"` | No - Wave 0 |
| PROXY-02c | Credentials never appear in log output | unit | `npx vitest run src/upstream/upstream-credential-store.test.ts -t "redact"` | No - Wave 0 |
| SEC-02a | Upstream credentials redacted from error responses | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "redact"` | No - Wave 0 |
| SEC-02b | Upstream credentials redacted from structured log entries | unit | `npx vitest run src/auth/auth-redaction.test.ts -t "upstream"` | No - Wave 0 |
| SEC-02c | JWT patterns in upstream error messages are sanitized | unit | `npx vitest run src/auth/auth-redaction.test.ts -t "sanitize.*upstream"` | No - Wave 0 |
| REL-01a | Heartbeat pings sent at configured interval | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "interval"` | No - Wave 0 |
| REL-01b | Heartbeat failure triggers connection state change | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "failure"` | No - Wave 0 |
| REL-01c | Heartbeat stopped when connection closes | unit | `npx vitest run src/upstream/upstream-heartbeat.test.ts -t "cleanup"` | No - Wave 0 |
| REL-02a | Session reaper closes upstream connections for expired sessions | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "reaper"` | No - Wave 0 |
| REL-02b | No upstream connection leak on unclean downstream disconnect | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "unclean"` | No - Wave 0 |
| REL-02c | closeAll releases all connections for a session | unit | `npx vitest run src/upstream/upstream-connection-manager.test.ts -t "closeAll"` | No - Wave 0 |
| REL-03a | Upstream connection timeout produces UpstreamTimeoutError | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "timeout"` | No - Wave 0 |
| REL-03b | Upstream auth failure produces UpstreamAuthError | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "auth"` | No - Wave 0 |
| REL-03c | Upstream unavailable produces UpstreamConnectionError | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "unavailable"` | No - Wave 0 |
| REL-03d | All upstream errors include correlation IDs | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "correlation"` | No - Wave 0 |
| REL-03e | No raw stack traces in upstream error payloads to client | unit | `npx vitest run src/upstream/upstream-errors.test.ts -t "no stack"` | No - Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run src/upstream/ && npm run typecheck`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/upstream/upstream-connection-manager.test.ts` - covers PROXY-01, REL-02
- [ ] `src/upstream/upstream-credential-store.test.ts` - covers PROXY-02
- [ ] `src/upstream/upstream-heartbeat.test.ts` - covers REL-01
- [ ] `src/upstream/upstream-errors.test.ts` - covers REL-03, SEC-02 (error path)
- [ ] `src/auth/auth-redaction.test.ts` updates - covers SEC-02 (redaction extension)
- [ ] Mock upstream MCP server utility for integration tests

## Sources

### Primary (HIGH confidence)
- MCP SDK 1.27.1 installed types: `node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts` - Client API
- MCP SDK 1.27.1 installed types: `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts` - StreamableHTTPClientTransport API
- npm registry: `@modelcontextprotocol/sdk` version 1.28.0 confirmed current
- Existing codebase: `src/types/http-transport.ts` (SessionData), `src/transport/http-transport.ts` (destroySession, session reaper), `src/core/errors.ts` (error hierarchy), `src/auth/auth-redaction.ts` (redaction infrastructure), `src/profile/upstream-mcp-config.ts` (upstream config validation)

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` - gateway pipeline model and component boundaries
- `.planning/research/PITFALLS.md` - security and reliability pitfalls with prevention strategies
- `.planning/research/STACK.md` - stack recommendations for MCP SDK upgrade

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - MCP SDK is already a dependency; Client API verified from installed types
- Architecture: HIGH - patterns derived from existing codebase conventions and SDK API shape
- Pitfalls: HIGH - derived from detailed pitfalls research + codebase review of existing redaction/session code

**Research date:** 2026-03-26
**Valid until:** 2026-04-26 (30 days - stable dependency, well-understood domain)
