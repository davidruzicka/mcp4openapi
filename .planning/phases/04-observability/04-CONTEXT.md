# Phase 4: Observability — Context

## Goal
Every tool call is audited with identity and outcome; operators have metrics and health endpoints to monitor the gateway.

## Requirements
- **OBS-01**: Every tools/call request produces a structured audit log entry containing: session ID, resolved client identity, tool name, upstream server URL (host only, no credentials), invocation outcome (success/error code), and wall-clock duration
- **OBS-02**: Prometheus metrics expose per-upstream and per-client-identity counters and latency histograms for tools/list and tools/call requests; existing prom-client registry is extended (no second registry)
- **OBS-03**: GET /health returns 200 when the server is running; GET /ready returns 200 when at least one profile is loaded and the server can accept sessions; both endpoints are unauthenticated

## Dependencies
- Phase 2 (tool proxy — tools/call handler wired)
- Phase 3 (client auth gate — clientPrincipal on session)

## Existing Infrastructure (MUST extend, not replace)

### `src/core/metrics.ts` — MetricsCollector
- `recordToolCall(tool, status, durationSeconds, context?)` — uses labels: `tool`, `status`, `profile_id`, `tenant_id`
- `recordToolCallError(tool, errorType, context?)` — labels: `tool`, `error_type`, `profile_id`, `tenant_id`
- `recordHttpRequest(method, path, statusCode, duration, context?)` — labels: `method`, `path`, `status_code`, `profile_id`, `tenant_id`
- `MetricsContextLabels` interface: `{ profileId?: string; tenantId?: string }`
- Missing OBS-02 labels: `upstream_host` and `client_identity` — must be ADDED to existing counters/histograms

### `/health` endpoint — already implemented in `http-transport.ts:1644`
- Returns `{ status: 'ok', sessions: N }` — always 200
- `/ready` endpoint is MISSING — must be added
- Current `/health` conflates liveness + readiness; Phase 4 adds `/ready` as readiness probe

### `SessionData.clientPrincipal?: AuthorizedPrincipal`
- Set by ClientAuthGate (Phase 3) at session creation
- Available for audit attribution in tools/call handler
- `AuthorizedPrincipal.subject` = client identity string

### Upstream host
- Available from `profile.upstream_mcp.transport.url` at tool-call time
- Must strip to host-only (no credentials, no path) for audit/metrics

## Success Criteria

1. Every tools/call produces a structured audit log entry: `sessionId`, `clientPrincipal.subject` (or `anonymous`), `tool`, `upstream_host`, `outcome` (success/error), `durationMs`
2. Prometheus metrics include `upstream_host` and `client_identity` labels on tool call counters + histograms
3. GET /health → 200 (liveness: server running)
4. GET /ready → 200 when ≥1 profile loaded and server can accept sessions; 503 otherwise
5. Both /health and /ready are unauthenticated (bypass client auth gate)

## Key Decisions (Pre-Locked)

- Audit log = structured JSON via existing logger (`logger.info` with audit fields), NOT a separate logger — keeps operational simplicity
- `upstream_host` extraction: `new URL(url).host` — strips path, credentials, query
- Anonymous sessions (no clientPrincipal): use `'anonymous'` string for audit + metrics labels
- `/ready` definition: `this.profileStates.size > 0` (at least one profile loaded)
- `/health` stays as-is (liveness) — add `/ready` alongside it
- Both endpoints bypass rate limiter (or use separate low-limit) and bypass client auth gate
- OBS-02: extend `MetricsContextLabels` with `upstreamHost?: string` and `clientIdentity?: string`; add labels to existing `mcpToolCallsTotal` + `mcpToolCallDuration` counters — NO new registry

## Scope Boundaries
- No separate audit database or file — logger only
- No log rotation, sampling, or filtering — emit all tool calls
- No business metrics beyond OBS-01/02/03 requirements
- No changes to existing `/metrics` endpoint (Prometheus scrape already wired)
