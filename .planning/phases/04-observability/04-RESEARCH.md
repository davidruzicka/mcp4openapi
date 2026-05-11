# Phase 4: Observability - Research

**Researched:** 2026-05-11
**Domain:** Prometheus metrics extension, structured audit logging, HTTP health/readiness endpoints
**Confidence:** HIGH

## Summary

Phase 4 adds three capabilities to the existing HTTP transport: (1) per-call structured audit logs emitted via the existing `logger.info`, (2) two new Prometheus labels (`upstream_host`, `client_identity`) on the existing `mcpToolCallsTotal` and `mcpToolCallDuration` metrics, and (3) a `/ready` endpoint alongside the existing `/health`.

All three changes are additive. No existing public API is removed. The main risk is Prometheus label cardinality: adding `client_identity` to a counter that already carries `tool` and `profile_id` can produce a large label-value cross-product when many distinct identities make calls to many tools. The CONTEXT.md decision to use only `upstream_host` and `client_identity` (not the full session ID or user agent) is correct; both values have bounded cardinality in practice.

**Primary recommendation:** Implement in two plans - (A) metrics extension + audit log in `mcp-server.ts`, (B) `/ready` endpoint + test coverage. The metrics extension requires coordinated changes to `MetricsContextLabels`, `MetricsCollector`, `resolveMetricsContext`, and all `recordToolCall` call sites - keep these atomic in one plan.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Audit log = structured JSON via existing logger (`logger.info` with audit fields), NOT a separate logger
- `upstream_host` extraction: `new URL(url).host` - strips path, credentials, query
- Anonymous sessions (no clientPrincipal): use `'anonymous'` string for audit + metrics labels
- `/ready` definition: `this.profileStates.size > 0` (at least one profile loaded)
- `/health` stays as-is (liveness) - add `/ready` alongside it
- Both endpoints bypass rate limiter (or use separate low-limit) and bypass client auth gate
- OBS-02: extend `MetricsContextLabels` with `upstreamHost?: string` and `clientIdentity?: string`; add labels to existing `mcpToolCallsTotal` + `mcpToolCallDuration` - NO new registry

### Claude's Discretion
- (none specified)

### Deferred Ideas (OUT OF SCOPE)
- No separate audit database or file - logger only
- No log rotation, sampling, or filtering
- No business metrics beyond OBS-01/02/03 requirements
- No changes to existing `/metrics` endpoint
</user_constraints>

---

## Standard Stack

No new npm dependencies required. Everything uses existing stack.

| Component | Current | Why Sufficient |
|-----------|---------|----------------|
| `prom-client` | Already in `src/core/metrics.ts` | Adding labels to existing Counter/Histogram instances |
| Logger | `this.logger` (existing in every component) | Structured JSON via `logger.info` |
| Express | Existing in `http-transport.ts` | New route registration for `/ready` |

**Installation:** None needed.

---

## Architecture Patterns

### Existing Pattern: MetricsContextLabels Extension

`MetricsContextLabels` (file: `src/core/metrics.ts`, lines 20-23) is the carrier object passed from call sites into `recordToolCall`. The pattern for all existing labels is: optional in the interface, resolved to defaults in `resolveContextLabels()`.

**Exact interface change needed:**

```typescript
// src/core/metrics.ts, lines 20-23 — current
export interface MetricsContextLabels {
  profileId?: string | null;
  tenantId?: string | null;
}

// After change — add two optional fields
export interface MetricsContextLabels {
  profileId?: string | null;
  tenantId?: string | null;
  upstreamHost?: string | null;    // ADD: extracted via new URL(url).host
  clientIdentity?: string | null;  // ADD: AuthorizedPrincipal.subject or 'anonymous'
}
```

### Existing Pattern: resolveContextLabels()

File: `src/core/metrics.ts`, lines 411-418. Currently returns `{ profile_id, tenant_id }`. Must be extended to return `{ profile_id, tenant_id, upstream_host, client_identity }`.

**Exact change to `resolveContextLabels`:**

```typescript
// current return type: { profile_id: string; tenant_id: string }
// new return type: { profile_id: string; tenant_id: string; upstream_host: string; client_identity: string }

private resolveContextLabels(context?: MetricsContextLabels): {
  profile_id: string; tenant_id: string; upstream_host: string; client_identity: string;
} {
  const profileId = context?.profileId?.trim();
  const tenantId = context?.tenantId?.trim();
  const upstreamHost = context?.upstreamHost?.trim();
  const clientIdentity = context?.clientIdentity?.trim();
  return {
    profile_id: profileId && profileId.length > 0 ? profileId : 'unknown',
    tenant_id: tenantId && tenantId.length > 0 ? tenantId : 'none',
    upstream_host: upstreamHost && upstreamHost.length > 0 ? upstreamHost : 'none',
    client_identity: clientIdentity && clientIdentity.length > 0 ? clientIdentity : 'anonymous',
  };
}
```

### Existing Pattern: Counter/Histogram labelNames

Prometheus requires that labelNames declared at construction exactly match labels passed to `.inc()` / `.observe()`. **Adding a label after construction is not possible** - the labelNames array must be changed at construction time in the `MetricsCollector` constructor.

**Exact changes in constructor (lines 101-121):**

```typescript
// mcpToolCallsTotal — line 102
labelNames: ['tool', 'status', 'profile_id', 'tenant_id', 'upstream_host', 'client_identity'],

// mcpToolCallDuration — line 109
labelNames: ['tool', 'status', 'profile_id', 'tenant_id', 'upstream_host', 'client_identity'],

// mcpToolCallErrors — line 116
// NOTE: mcpToolCallErrors does NOT need upstream_host/client_identity per OBS-02
// OBS-02 specifically targets tool call counters and histograms, not the error sub-counter.
// Add only if desired for consistency - CONTEXT.md is silent on this.
// Recommendation: add to errors counter too for query consistency.
labelNames: ['tool', 'error_type', 'profile_id', 'tenant_id', 'upstream_host', 'client_identity'],
```

**All `.inc()` and `.observe()` calls in `recordToolCall`, `recordToolCallError` must be updated to include the two new label keys** when passing the resolved labels object.

### Existing Pattern: recordToolCall call sites

There are two `handleToolCall` code paths in `src/mcp/mcp-server.ts`:

**Path 1 - stdio/SDK path** (lines 954-1030, `setRequestHandler(CallToolRequestSchema,...)`):
- `metricsContext` created at line 958: `this.resolveMetricsContext(undefined, undefined)`
- No `sessionId`, no `clientPrincipal` access possible here (stdio transport)
- `upstream_host`: `this.getBaseUrl()` gives the API base URL; extract host with `new URL(...).host`. Wrap in try/catch for non-URL values.
- `client_identity`: No session = no principal; leave as `undefined` (resolves to `'anonymous'`)
- `recordToolCall` at lines 1001, 1015; `recordToolCallError` at line 1016

**Path 2 - HTTP/handleToolCall path** (lines 1569-1818):
- `metricsContext` created at line 1576: `this.resolveMetricsContext(profileId, sessionId)`
- `sessionId` is available as a parameter
- `clientPrincipal` requires a NEW accessor: `this.httpTransport?.getSessionClientPrincipal(profileId, sessionId)`
- `upstream_host`:
  - Upstream MCP path (lines 1607-1690): `upstreamMcpForCall.transport.url` is available at line 1607 as `const upstreamMcpForCall = this.getUpstreamMcpConfig(profileId)` - extract `new URL(upstreamMcpForCall.transport.url).host`
  - Local tool path (lines 1693-1818): upstream is the backend REST API - extract from `this.getBaseUrl()` or tenant base URL (`this.httpTransport?.getSessionTenantContext(...)?.tenantBaseUrl`)
- `metricsContext` is built once at line 1576 and reused for all `recordToolCall` / `recordUpstreamReject` calls in this function. **The upstream_host is only known per-path** (upstream MCP vs local tool vs early-reject paths). Options:
  - Option A (recommended): Build `metricsContext` once at line 1576 with `clientIdentity` populated (known from session), then create an enriched context (spread + upstreamHost) just before each `recordToolCall` invocation in each branch.
  - Option B: Extend `resolveMetricsContext` signature to take upstream host directly. Simpler but couples resolution to call-site knowledge.
  - **Recommendation:** Option A - extend context inline at each branch with `{ ...metricsContext, upstreamHost }` to preserve current pattern of a single context object per call.

**Path 2 - metricsBundle for handleUpstreamToolCall** (lines 2005-2061):
- `metricsBundle.context` (type `MetricsContextLabels`) is passed in from `handleToolCall` at line 1689
- The bundle already carries the context; it needs to carry an upstream_host-enriched version
- The `provider.transport.url` is available inside `handleUpstreamToolCall` as parameter `provider`
- Recommendation: enrich `metricsBundle.context` with `upstreamHost` before passing into `handleUpstreamToolCall`, since `upstreamMcpForCall.transport.url` is available at the call site (line 1684-1690)

**Path 2 - recordUpstreamReject** (lines 2963-2976):
- Takes `metricsContext: MetricsContextLabels` - will automatically carry the new labels if the context is enriched before the call (already happens at lines 1628, 1635, etc.)

### New accessor needed: `getSessionClientPrincipal`

File: `src/transport/http-transport.ts` - must add alongside existing `getSession*` methods (around line 4260 area, after `getSessionTenantContext`).

```typescript
// Add after getSessionTenantContext (line ~4258)
public getSessionClientPrincipal(profileId: string, sessionId: string): AuthorizedPrincipal | undefined {
  return this.profileStates.get(profileId)?.sessions.get(sessionId)?.clientPrincipal;
}
```

This follows the exact pattern of every other `getSession*` accessor.

### /ready endpoint pattern

File: `src/transport/http-transport.ts`, route registration block (lines 1638-1659). The `/ready` endpoint must be registered immediately after `/health`.

**readiness condition:** `this.profileStates.size > 0` (from CONTEXT.md locked decision, lines 1647 pattern confirms `profileStates` is accessible).

```typescript
// Insert after /health handler (after line 1659):
this.app.get('/ready', mcpRateLimiter, (req: Request, res: Response) => {
  const startTime = Date.now();
  const ready = this.profileStates.size > 0;
  const statusCode = ready ? 200 : 503;
  res.status(statusCode).json(
    ready
      ? { status: 'ready', profiles: this.profileStates.size }
      : { status: 'not ready', reason: 'no profiles loaded' }
  );
  if (this.metrics) {
    const duration = (Date.now() - startTime) / 1000;
    this.metrics.recordHttpRequest(req.method, req.path, statusCode, duration, {
      profileId: 'unknown',
      tenantId: 'none',
    });
  }
});
```

Note: The existing `/health` also uses `mcpRateLimiter` (line 1644). `/ready` should use the same rate limiter. Both endpoints are unauthenticated because `clientAuthGate` is only applied inside `handlePost` (line 2873), not at the route level.

### normalizePath update

File: `src/core/metrics.ts`, `normalizePath` method (lines 384-396). Currently handles `/mcp`, `/metrics`, `/health`. Must add `/ready` to prevent high-cardinality path label:

```typescript
if (pathWithoutQuery === '/mcp' ||
    pathWithoutQuery === '/metrics' ||
    pathWithoutQuery === '/health' ||
    pathWithoutQuery === '/ready') {   // ADD
  return pathWithoutQuery;
}
```

### Audit log emission

Emit `logger.info` in `handleToolCall` (Path 2) after the success/error result is known, at the same point where `metrics.recordToolCall` is called.

**Success path** (line 1756-1758) - emit after metrics:
```typescript
this.logger.info('audit:tool_call', {
  sessionId,
  clientPrincipal: clientPrincipal?.subject ?? 'anonymous',
  tool: toolName,
  upstreamHost,
  outcome: 'success',
  durationMs: Math.round(durationSeconds * 1000),
});
```

**Error path** (line 1773-1778) - emit after metrics:
```typescript
this.logger.info('audit:tool_call', {
  sessionId,
  clientPrincipal: clientPrincipal?.subject ?? 'anonymous',
  tool: toolName,
  upstreamHost,
  outcome: 'error',
  durationMs: Math.round(durationSeconds * 1000),
});
```

**Early-reject paths** (OAuth unauth at line 1582, recordUpstreamReject at lines 1628-1676): These also count as tool call outcomes. Audit log should be emitted for each. For upstream-reject cases, `upstreamHost` is known (`upstreamMcpForCall.transport.url`).

**Stdio path** (CallToolRequestSchema handler, lines 954-1030): Also needs audit log at lines 1001 and 1015. No sessionId available (stdio), so emit `sessionId: null`, `clientPrincipal: 'anonymous'`.

**Upstream host for audit on local tool path:**
- Non-tenant session: `this.getBaseUrl()` - but this can return a non-URL string (env var missing). Use try/catch: `try { new URL(baseUrl).host } catch { baseUrl }` to safely extract host.
- Tenant session: prefer `tenantBaseUrl` from `getSessionTenantContext`, fallback to `getBaseUrl()`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Prometheus cardinality protection | Custom label sanitizer | Apply `.slice(0, N)` truncation consistently (already done for `safeToolName` at line 2972) |
| URL host extraction | Custom parser | `new URL(url).host` (built-in, strips credentials+path+query) |
| Structured logging | Custom serializer | Existing `this.logger.info(message, fields)` |

---

## Common Pitfalls

### Pitfall 1: Prometheus label count mismatch after adding new labelNames

**What goes wrong:** `labelNames` at construction declares N labels; `.inc({ ... })` call passes N-2 labels. prom-client silently drops or errors depending on version.

**Why it happens:** `recordToolCall` calls `mcpToolCallsTotal.inc({ tool, status, profile_id, tenant_id })` - after adding `upstream_host` and `client_identity` to `labelNames`, these keys MUST also appear in every `.inc()` / `.observe()` call.

**How to avoid:** `resolveContextLabels` already returns a flat label object. Extend it to return all four keys (including `upstream_host` and `client_identity`). Then every consumer of `resolveContextLabels` automatically gets all labels - no individual call sites need to be manually updated.

**Warning signs:** Prometheus output shows metrics with `upstream_host=""` or missing label keys; test assertions fail with "metric not found".

### Pitfall 2: Cardinality explosion with client_identity label

**What goes wrong:** Each unique `(tool, status, profile_id, tenant_id, upstream_host, client_identity)` tuple creates a new time series. With 50 tools, 2 statuses, 3 profiles, 1 tenant, 1 upstream, and 100 client identities = 30,000 time series for `mcpToolCallsTotal` alone.

**Why it happens:** `client_identity` is the subject from the JWT, which is typically a user ID or service account name. These can be unbounded in multi-tenant deployments.

**How to avoid:**
- Truncate `client_identity` label values to a reasonable length (e.g., 64 chars, consistent with `safeToolName` truncation at line 2972)
- The `resolveContextLabels` method is the right place to apply this truncation
- In `resolveContextLabels`: `clientIdentity ? clientIdentity.slice(0, 64) : 'anonymous'`
- **Operators with very high cardinality can suppress client_identity** by setting `clientIdentity: undefined` in the context - resolves to `'anonymous'`. Document this.

**Warning signs:** Prometheus memory usage grows unboundedly; scrape timeout increases.

### Pitfall 3: `new URL(url).host` throws on invalid URLs

**What goes wrong:** `getBaseUrl()` can return a bare hostname, a relative path, or an env var default that is not a valid URL. `new URL('api.example.com').host` throws `TypeError: Invalid URL`.

**Why it happens:** `getBaseUrl()` returns the raw value from `interceptors.base_url.default` or `parser.getBaseUrl()`, which may be `'https://api.example.com'` (valid) or `'api.example.com'` (invalid for `new URL`).

**How to avoid:**
```typescript
function extractHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
```
Apply this helper everywhere host extraction is needed. Already aligns with CONTEXT.md's locked decision (`new URL(url).host`).

**Warning signs:** Unhandled `TypeError` during tool call; server error logged.

### Pitfall 4: Two different handleToolCall paths must both emit audit log

**What goes wrong:** Audit log added to `handleToolCall` (HTTP path, line 1569) but NOT to the `setRequestHandler(CallToolRequestSchema, ...)` (stdio path, line 954). Stdio tool calls are silently unaudited.

**Why it happens:** There are two distinct code paths for tool execution. The HTTP path (`handleToolCall`) is used when MCP operates over HTTP transport. The SDK path (`setRequestHandler`) is used for stdio transport. Both invoke `executeSimpleTool` but at different entry points.

**How to avoid:** Add audit log emission to both. For stdio: emit with `sessionId: null`, `clientPrincipal: 'anonymous'`.

### Pitfall 5: metricsContext is built before upstream host is known

**What goes wrong:** `metricsContext = resolveMetricsContext(profileId, sessionId)` at line 1576 is called at the top of `handleToolCall`, before the code knows whether it's an upstream MCP call or local tool call, and before the upstream URL is accessed.

**Why it happens:** `upstream_host` differs between the upstream-MCP branch (`upstreamMcpForCall.transport.url`) and the local-tool branch (`getBaseUrl()` or tenant URL). There is no single point where both are known simultaneously at context-build time.

**How to avoid:** Build the base context at line 1576 with `profileId`, `tenantId`, and `clientIdentity` (all known from session). Then enrich with `upstreamHost` inline at each branch using spread:
```typescript
const enrichedContext = { ...metricsContext, upstreamHost: extractHost(url) };
metrics.recordToolCall(toolName, 'success', durationSeconds, enrichedContext);
```
This avoids rebuilding the full context and keeps the current pattern clean.

---

## Precise Call-Site List for recordToolCall Changes

All call sites where `metricsContext` must be enriched with `upstreamHost`:

| File | Line | Path | upstream_host source |
|------|------|------|---------------------|
| `src/mcp/mcp-server.ts` | 1001 | SDK/stdio success | `extractHost(this.getBaseUrl())` |
| `src/mcp/mcp-server.ts` | 1015 | SDK/stdio error | `extractHost(this.getBaseUrl())` |
| `src/mcp/mcp-server.ts` | 1584 | HTTP OAuth unauth | `extractHost(upstreamMcpForCall?.transport.url ?? this.getBaseUrl())` |
| `src/mcp/mcp-server.ts` | 1628 | HTTP upstream filter-reject | `extractHost(upstreamMcpForCall.transport.url)` |
| `src/mcp/mcp-server.ts` | 1635 | HTTP upstream policy-reject | `extractHost(upstreamMcpForCall.transport.url)` |
| `src/mcp/mcp-server.ts` | 1647 | HTTP upstream invalid-name | `extractHost(upstreamMcpForCall.transport.url)` |
| `src/mcp/mcp-server.ts` | 1657 | HTTP upstream provider-policy-reject | `extractHost(upstreamMcpForCall.transport.url)` |
| `src/mcp/mcp-server.ts` | 1676 | HTTP upstream sanitization-reject | `extractHost(upstreamMcpForCall.transport.url)` |
| `src/mcp/mcp-server.ts` | 1758 | HTTP local success | `extractHost(tenantBaseUrl ?? this.getBaseUrl())` |
| `src/mcp/mcp-server.ts` | 1776 | HTTP local error | `extractHost(tenantBaseUrl ?? this.getBaseUrl())` |
| `src/mcp/mcp-server.ts` | 2041 | handleUpstreamToolCall success | `extractHost(provider.transport.url)` (pass in bundle) |
| `src/mcp/mcp-server.ts` | 2052 | handleUpstreamToolCall error | `extractHost(provider.transport.url)` (pass in bundle) |
| `src/mcp/mcp-server.ts` | 2974 | recordUpstreamReject (all) | already in enriched metricsContext from caller |

For the `handleUpstreamToolCall` path: enrich `metricsBundle.context` with `upstreamHost` **before** passing the bundle at line 1689, since `upstreamMcpForCall.transport.url` is available there.

---

## Plan Split Recommendation

### Plan A: OBS-01 + OBS-02 (Metrics + Audit Log) - `src/mcp/mcp-server.ts` + `src/core/metrics.ts`

Changes:
1. `src/core/metrics.ts`: Extend `MetricsContextLabels` + `resolveContextLabels` + Counter/Histogram `labelNames` + `.inc()` / `.observe()` call sites in `recordToolCall`, `recordToolCallError`
2. `src/transport/http-transport.ts`: Add `getSessionClientPrincipal` accessor (3 lines)
3. `src/mcp/mcp-server.ts`: Extend `resolveMetricsContext` to populate `clientIdentity`, enrich contexts with `upstreamHost` at each branch, emit `logger.info('audit:tool_call', ...)` at all success/error points
4. `src/core/metrics.test.ts`: Tests for new labels
5. `src/mcp/mcp-server.test.ts` or integration test: Audit log output test, metrics label test

**Why atomic:** Prometheus will reject metric observations with missing labels if labelNames and label objects are out of sync. The metrics.ts change and all mcp-server.ts call-site changes must land in one commit.

### Plan B: OBS-03 (Health + Readiness endpoints)

Changes:
1. `src/transport/http-transport.ts`: Add `/ready` route (after `/health` at line 1659), update `normalizePath` for `/ready`
2. `src/transport/http-transport.test.ts`: Tests for `/ready` - 200 when profiles loaded, 503 when not, unauthenticated
3. `src/transport/http-transport-security.test.ts`: Verify `/ready` response has same security headers as `/health`

**Why separate:** Fully independent from metrics/audit. Can be implemented, tested, and verified without touching metrics code at all.

---

## Code Examples

### extractHost helper (verified pattern)

```typescript
// Safe URL host extraction - handles non-URL base URLs from env/config
function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // url may be a relative path, bare hostname, or placeholder - return as-is
    return url;
  }
}
```

### MetricsContextLabels extended (src/core/metrics.ts, lines 20-23)

```typescript
export interface MetricsContextLabels {
  profileId?: string | null;
  tenantId?: string | null;
  upstreamHost?: string | null;   // new - host only, no path/credentials
  clientIdentity?: string | null; // new - AuthorizedPrincipal.subject or 'anonymous'
}
```

### resolveContextLabels extended

```typescript
private resolveContextLabels(context?: MetricsContextLabels): {
  profile_id: string; tenant_id: string; upstream_host: string; client_identity: string;
} {
  const profileId = context?.profileId?.trim();
  const tenantId = context?.tenantId?.trim();
  const upstreamHost = context?.upstreamHost?.trim();
  const clientIdentity = context?.clientIdentity?.trim();
  return {
    profile_id: profileId && profileId.length > 0 ? profileId : 'unknown',
    tenant_id: tenantId && tenantId.length > 0 ? tenantId : 'none',
    upstream_host: upstreamHost && upstreamHost.length > 0 ? upstreamHost.slice(0, 128) : 'none',
    client_identity: clientIdentity && clientIdentity.length > 0 ? clientIdentity.slice(0, 64) : 'anonymous',
  };
}
```

### getSessionClientPrincipal (src/transport/http-transport.ts, add after line ~4258)

```typescript
public getSessionClientPrincipal(profileId: string, sessionId: string): AuthorizedPrincipal | undefined {
  return this.profileStates.get(profileId)?.sessions.get(sessionId)?.clientPrincipal;
}
```

### Audit log emission in handleToolCall (success branch)

```typescript
const durationSeconds = (Date.now() - startTime) / 1000;
metrics?.recordToolCall(toolName, 'success', durationSeconds, { ...metricsContext, upstreamHost });
this.logger.info('audit:tool_call', {
  sessionId: sessionId ?? null,
  clientPrincipal: clientIdentity,
  tool: toolName,
  upstreamHost,
  outcome: 'success',
  durationMs: Math.round(durationSeconds * 1000),
});
```

### /ready endpoint (src/transport/http-transport.ts, after line 1659)

```typescript
this.app.get('/ready', mcpRateLimiter, (req: Request, res: Response) => {
  const startTime = Date.now();
  const ready = this.profileStates.size > 0;
  const statusCode = ready ? 200 : 503;
  res.status(statusCode).json(
    ready
      ? { status: 'ready', profiles: this.profileStates.size }
      : { status: 'not ready', reason: 'no profiles loaded' }
  );
  if (this.metrics) {
    const duration = (Date.now() - startTime) / 1000;
    this.metrics.recordHttpRequest(req.method, req.path, statusCode, duration, {
      profileId: 'unknown', tenantId: 'none',
    });
  }
});
```

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (vitest.config.ts) |
| Config file | `vitest.config.ts` |
| Quick run command | `npm test -- -t "audit\|ready\|upstream_host\|client_identity"` |
| Full suite command | `npm test` |

### Phase Requirements - Test Map

| Req ID | Behavior | Test Type | File |
|--------|----------|-----------|------|
| OBS-01 | `logger.info('audit:tool_call', ...)` emitted on success | unit | `src/mcp/mcp-server.test.ts` |
| OBS-01 | Audit log contains sessionId, clientPrincipal, tool, upstreamHost, outcome, durationMs | unit | `src/mcp/mcp-server.test.ts` |
| OBS-01 | Anonymous session uses 'anonymous' string | unit | `src/mcp/mcp-server.test.ts` |
| OBS-02 | `upstream_host` label appears in Prometheus output | unit | `src/core/metrics.test.ts` |
| OBS-02 | `client_identity` label appears in Prometheus output | unit | `src/core/metrics.test.ts` |
| OBS-02 | Both labels default to 'none'/'anonymous' when not supplied | unit | `src/core/metrics.test.ts` |
| OBS-03 | GET /ready returns 200 when profiles loaded | integration | `src/transport/http-transport.test.ts` |
| OBS-03 | GET /ready returns 503 when no profiles loaded | integration | `src/transport/http-transport.test.ts` |
| OBS-03 | GET /ready is unauthenticated (no auth header needed) | integration | `src/transport/http-transport.test.ts` |
| OBS-03 | GET /health still returns 200 (not broken) | regression | `src/transport/http-transport.test.ts` |

### Wave 0 Gaps

All test files exist. No new test infrastructure needed. Existing `src/core/metrics.test.ts` and `src/transport/http-transport.test.ts` need additional test cases (not new files).

---

## Environment Availability

Step 2.6: SKIPPED (no external tool dependencies - pure TypeScript/Node.js code changes only).

---

## Open Questions

1. **Should `mcpToolCallErrors` counter also carry `upstream_host` + `client_identity`?**
   - What we know: OBS-02 specifies "tool call counters/histograms" - `mcpToolCallErrors` is a sub-counter used alongside `mcpToolCallsTotal`
   - What's unclear: CONTEXT.md says "add labels to existing `mcpToolCallsTotal` + `mcpToolCallDuration` counters" specifically
   - Recommendation: Add to errors counter too for query consistency. The plan author should confirm with user if uncertain.

2. **Audit log for early-reject paths (filter/policy/sanitization rejections)?**
   - What we know: OBS-01 says "every tools/call request" - these are tools/call requests
   - What's unclear: Whether "outcome" for early rejects should be a specific string (e.g., `'rejected:FilterRejection'`) or just `'error'`
   - Recommendation: Use `outcome: 'error'` with an additional `rejectReason` field for clarity. Consistent with CONTEXT.md's simple `success/error` requirement.

---

## Sources

### Primary (HIGH confidence)
- Direct code reading of `src/core/metrics.ts` (full file, 419 lines)
- Direct code reading of `src/mcp/mcp-server.ts` (targeted sections: lines 940-1030, 1569-1820, 2005-2090, 2963-2989)
- Direct code reading of `src/transport/http-transport.ts` (targeted sections: lines 1557-1685, 3600-3820, 4180-4260)
- Direct code reading of `src/types/http-transport.ts` (full file)
- Direct code reading of `src/auth/inbound-auth-principal.ts` (full file)
- Direct code reading of `src/types/profile.ts` (lines 80-135)
- Direct code reading of `src/core/metrics.test.ts` (lines 1-180)
- Direct code reading of `src/transport/http-transport.test.ts` (lines 1820-1829)
- Direct code reading of `src/transport/http-transport-security.test.ts` (lines 130-151)
- Direct code reading of `.planning/phases/04-observability/04-CONTEXT.md` (full file)

### Tertiary (LOW confidence - not applicable, no web research needed)
- N/A: All findings verified directly from source code

---

## Metadata

**Confidence breakdown:**
- File/line locations: HIGH - read directly from source
- Label change safety: HIGH - prom-client labelNames contract is well-established; verified pattern in existing code
- Client principal access: HIGH - `SessionData.clientPrincipal` field exists, pattern matches all other `getSession*` accessors
- Cardinality risk assessment: HIGH - verified by inspecting existing label cardinality and data flow
- /ready readiness condition: HIGH - `this.profileStates.size > 0` locked in CONTEXT.md, field confirmed in code

**Research date:** 2026-05-11
**Valid until:** 2026-06-10 (30 days - stable codebase)
