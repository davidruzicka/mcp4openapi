---
phase: 02-tool-discovery-and-call-proxy
type: fix
created: 2026-04-07
source: /recheck review
status: pending
---

# Phase 02 Recheck Fix Plan

Fix 7 issues found by parallel post-implementation review of Phase 02 (tool-discovery-and-call-proxy).

## Context

Branch: `feat/upstream-mcp-proxy-session-and-tool-discovery`
All changes on this branch. Run `npm test` before starting to confirm baseline.

---

## Fix 1 (Critical - Security): SSRF on main upstream transport URL

**File**: `src/upstream/upstream-connection-manager.ts`
**Location**: `createConnection()` method (~line 361)

**Problem**: `provider.transport.url` is never validated against `SSRFValidator`. Only `validation_endpoint` gets SSRF-checked. An attacker with profile control can point the transport URL at internal/private addresses.

**Fix**: Add SSRF validation at the top of `createConnection()`, before `buildAuthUrl()`:

```typescript
private async createConnection(
  sessionId: string,
  provider: UpstreamMcpServerConfig,
  token: string | undefined,
): Promise<Client> {
  // SSRF check: validate transport URL before opening any network connection
  await this.ssrfValidator.validate(provider.transport.url, {
    allowPrivateNetwork: process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK === 'true',
  });

  const authHeaders = buildAuthHeaders(provider, token);
  // ... rest unchanged
```

**Test**: Add a test in `src/upstream/upstream-connection-manager.test.ts` in the existing describe block:
```
it('rejects createConnection when transport.url fails SSRF validation')
```
Use the existing `ssrfValidator` mock pattern. Verify `UpstreamConnectionError` is thrown when SSRF validator rejects.

---

## Fix 2 (Critical - Security): tool.inputSchema passes unsanitized to downstream

**File**: `src/upstream/upstream-tool-sanitizer.ts`
**Location**: `sanitizeToolList()` function

**Problem**: `tool.name` and `tool.description` are sanitized but `tool.inputSchema` (arbitrary nested JSON schema) passes through unchanged. Upstream can embed `<`, `>`, `` ` `` in nested schema `description`, `title`, `examples`, or enum values.

**Fix**: Add a recursive string-field sanitizer for inputSchema. Drop the tool if any forbidden chars are found in the schema tree:

```typescript
// Add after DESCRIPTION_FORBIDDEN_CHARS constant:
/**
 * Recursively scan a JSON Schema object for forbidden characters in string values.
 * Returns true if any string value contains forbidden chars.
 */
function schemaContainsForbiddenChars(value: unknown, depth = 0): boolean {
  if (depth > 10) return false; // Guard against deeply nested schemas
  if (typeof value === 'string') return DESCRIPTION_FORBIDDEN_CHARS.test(value);
  if (Array.isArray(value)) return value.some(v => schemaContainsForbiddenChars(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some(v => schemaContainsForbiddenChars(v, depth + 1));
  }
  return false;
}
```

Add a check in `sanitizeToolList()` after the existing description checks:

```typescript
} else if (tool.inputSchema && schemaContainsForbiddenChars(tool.inputSchema)) {
  reason = 'forbidden characters in input schema';
}
```

**Test**: Add to `src/upstream/upstream-tool-sanitizer.test.ts`:
- Tool with `<script>` in `inputSchema.properties.x.description` -> dropped, reason `'forbidden characters in input schema'`
- Tool with `` ` `` in nested schema enum value -> dropped
- Tool with clean schema -> passes through unchanged
- Depth limit: deeply nested (>10 levels) schema is not scanned (no crash)

---

## Fix 3 (Critical): Unhandled promise rejection in async notification handler

**File**: `src/upstream/upstream-connection-manager.ts`
**Location**: `wireNotificationListeners()` (~line 220)

**Problem**: The handler is `async` but `handleUpstreamNotification` is synchronous. If `downstreamNotifyFn` (called inside `handleUpstreamNotification`) throws, the async handler returns a rejected Promise with no catch handler. Unhandled rejections crash Node.js in strict configurations.

**Fix**: Remove `async` from the handler (nothing is awaited) and wrap the body in try/catch:

```typescript
private wireNotificationListeners(client: Client, sessionId: string): void {
  for (const { schema, method } of UpstreamConnectionManager.NOTIFICATION_DISPATCH) {
    client.setNotificationHandler(schema, (notification) => {
      try {
        this.handleUpstreamNotification(sessionId, method, notification.params);
      } catch (error) {
        this.logger.error('Error handling upstream notification', error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
```

**Test**: Add to `src/upstream/upstream-connection-manager.test.ts` notification describe block:
```
it('does not propagate errors thrown by downstreamNotifyFn - logs instead')
```
Set `downstreamNotifyFn` to a function that throws, invoke the notification handler, assert no unhandled rejection and that logger.error was called.

---

## Fix 4 (Critical): Dead validation branch in handleUpstreamToolsList

**File**: `src/mcp/mcp-server.ts`
**Location**: `handleUpstreamToolsList()` (~line 1799)

**Problem**: `const rawTools = result.tools ?? []` followed by `if (!Array.isArray(rawTools))` - the `??` operator guarantees `rawTools` is always `[]` when `result.tools` is falsy, so the non-array branch is unreachable. A non-array `result.tools` (e.g. an object) would be silently coerced to `[]`.

**Fix**:

```typescript
// Before:
const rawTools = result.tools ?? [];
if (!Array.isArray(rawTools)) {
  throw new UpstreamMalformedResponseError(provider.name, 'tools field is not an array');
}

// After:
if (!Array.isArray(result.tools)) {
  throw new UpstreamMalformedResponseError(
    provider.name,
    `tools field is not an array (got ${result.tools === null ? 'null' : typeof result.tools})`,
  );
}
const rawTools = result.tools ?? [];
```

**Test**: Add to `src/mcp/mcp-server.test.ts` upstream proxy describe block:
```
it('returns MCP error when upstream listTools returns non-array tools field')
```
Mock `client.listTools()` to return `{ tools: { nested: [] } }` (object, not array). Assert error response with code -32603.

---

## Fix 5 (Important): destroyedSessions Set grows unbounded

**File**: `src/upstream/upstream-connection-manager.ts`
**Location**: `closeAll()` and `destroyedSessions` property (~line 69)

**Problem**: `destroyedSessions` is never pruned. Every session ID ever destroyed accumulates here forever. At scale (many sessions over time) this is a memory leak.

**Fix**: Add a TTL-based cleanup. Store destruction timestamps alongside the marker, prune stale entries on each `closeAll()` call:

```typescript
// Replace:
private readonly destroyedSessions = new Set<string>();

// With:
private readonly destroyedSessions = new Map<string, number>(); // sessionId -> destroyedAt (ms)
private static readonly DESTROYED_SESSION_TTL_MS = 60_000; // 60s grace period
```

Update all `.has()` / `.add()` references:
- `this.destroyedSessions.add(sessionId)` -> `this.destroyedSessions.set(sessionId, Date.now())`
- `this.destroyedSessions.has(sessionId)` -> `this.destroyedSessions.has(sessionId)` (no change needed - Map.has works the same)

Add cleanup at end of `closeAll()`:
```typescript
// Prune stale destroyed-session markers (memory leak prevention)
const cutoff = Date.now() - UpstreamConnectionManager.DESTROYED_SESSION_TTL_MS;
for (const [id, destroyedAt] of this.destroyedSessions) {
  if (destroyedAt < cutoff) this.destroyedSessions.delete(id);
}
```

**Test**: Add to `src/upstream/upstream-connection-manager.test.ts`:
```
it('prunes stale destroyedSessions entries after TTL to prevent memory leak')
```
Use `vi.useFakeTimers()`. Call `closeAll()` for several sessions, advance time past TTL, call `closeAll()` once more, assert old entries pruned from `destroyedSessions`.

---

## Fix 6 (Important): NOTIFICATION_DISPATCH schema type too narrow for extensibility

**File**: `src/upstream/upstream-connection-manager.ts`
**Location**: `NOTIFICATION_DISPATCH` static property (~line 93)

**Problem**: The array type is `schema: typeof ToolListChangedNotificationSchema`, which is the concrete type of a single schema. Adding a second notification type with a different Zod schema shape will fail the TypeScript array type constraint despite the "one-liner extensibility" comment.

**Fix**: Use a broader schema type. Check what base type the MCP SDK schemas share (likely `ZodSchema` or similar). Replace the hard-coded type with a structural supertype:

```typescript
import type { ZodSchema } from 'zod';

private static readonly NOTIFICATION_DISPATCH: ReadonlyArray<{
  schema: ZodSchema;
  method: string;
}> = [
  { schema: ToolListChangedNotificationSchema, method: 'notifications/tools/list_changed' },
];
```

If `ZodSchema` import causes type issues, use `Parameters<typeof client.setNotificationHandler>[0]` to infer the correct supertype from the SDK API.

**Test**: Verify TypeScript compiles (`npm run typecheck`). No new runtime tests needed - this is a compile-time fix.

---

## Fix 7 (Important): Dead export toMcpErrorResponse

**File**: `src/upstream/upstream-errors.ts`
**Location**: `toMcpErrorResponse()` function (~line 63)

**Problem**: `toMcpErrorResponse` is exported but never imported or called anywhere. Dead code.

**Fix**: Either:
- **Option A (preferred)**: Remove the export entirely if nothing uses it. Check with `grep -r "toMcpErrorResponse" src/` first to confirm no usages.
- **Option B**: If it's intended for future use, keep but add a comment: `// Reserved for external error mapping; not currently used internally`

**Test**: None needed. Run `npm run typecheck` + `npm test` to confirm nothing breaks.

---

## Execution Order

Run fixes in this order (each builds on the previous):

1. Fix 7 (trivial - remove dead export, verify nothing breaks)
2. Fix 6 (compile-time only - type change)
3. Fix 3 (notification handler - affects Fix 5 test setup)
4. Fix 4 (dead validation - standalone mcp-server change)
5. Fix 5 (destroyedSessions - requires understanding Fix 3 context)
6. Fix 1 (SSRF - requires reading SSRF validator API)
7. Fix 2 (inputSchema sanitizer - most complex, builds on sanitizer knowledge)

## Verification After All Fixes

```bash
npm run typecheck
npm test
npx vitest run src/upstream/upstream-tool-sanitizer.test.ts --reporter=verbose
npx vitest run src/upstream/upstream-connection-manager.test.ts --reporter=verbose
npx vitest run src/mcp/mcp-server.test.ts -t "upstream" --reporter=verbose
```

## Commit Message Template

```
fix(upstream): address recheck findings - SSRF on transport URL, inputSchema sanitization, notification handler rejection, dead validation branch, destroyedSessions memory leak, dispatch type narrowing, dead export
```
