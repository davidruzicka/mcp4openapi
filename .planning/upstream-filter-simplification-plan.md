# Upstream MCP Tool Filter - Simplification Plan

## Context

Branch: `feat/upstream-mcp-proxy-session-and-tool-discovery`  
PR: #235 (davidruzicka/mcp4openapi)

## Why

During PR review response for thread PRRT_kwDOQFfUbc56gpdf, a deferred-filter approach was
implemented (commit on this branch). After design analysis with the user, that approach is
overly complex. The correct solution is simpler: treat the X-Mcp4-Tools filter as a pure
name predicate evaluated inline, with no pre-computation or storage for upstream profiles.

## Design Decision

**For upstream proxy profiles (`upstream_mcp` configured, `tools: []`):**

- `_allow_list` / `_allow_read` at session init → fail immediately with `ValidationError`:
  `"_allow_list/_allow_read not supported for upstream proxy profiles. Use exact names or regex patterns instead."`
- Exact names / regex patterns → evaluated as a pure predicate at `tools/list` and `tools/call`
  time. No pre-computation, no storage of computed filter result.

**Why this is correct:**  
`filterRequest.exactNames.has(name)` and `filterRequest.regexPatterns.some(p => p.test(name))`
are stateless predicates on a string - they don't need the full tool list upfront.
Category rules (`_allow_list`/`_allow_read`) require OpenAPI metadata that upstream tools
never have - so rejecting them at init with a clear message is better than silent failure.

---

## Step 1: `src/mcp/mcp-server.ts` - Remove two private methods

### 1a. Remove `applyAndStoreUpstreamSessionFilter` (lines ~2799-2848)

Delete the entire method - it was added as part of the deferred approach and is no longer needed.

### 1b. Remove `resolveToolFilterForSession` (lines ~2850-2875)

Delete the entire method - also part of the deferred approach, no longer needed.

---

## Step 2: `src/tool-filter/compat.ts` + `src/tool-filter/index.ts` - Add `matchesSessionFilterByName`

**Why a utility, not inline access to `exactNames`/`regexPatterns` directly:**  
Direct access to those fields bypasses the same abstraction that OpenAPI profiles use
(`applySessionToolFilter` → `SessionToolFilter.apply` → `FilterEngine`). A named utility
keeps the evaluation path consistent and doesn't expose internal `SessionToolFilterRequest`
field structure at call sites.

Add to `src/tool-filter/compat.ts`:

```typescript
/**
 * Evaluate whether a single tool name passes the session filter name predicate.
 * For upstream proxy tools (no OpenAPI metadata); category rules must be rejected
 * at session init (applySessionToolFiltering) before this function is ever called.
 */
export function matchesSessionFilterByName(
  request: SessionToolFilterRequest,
  name: string,
): boolean {
  return request.exactNames.has(name) ||
    request.regexPatterns.some(p => p.test(name));
}
```

Export from `src/tool-filter/index.ts` - check the barrel file and add
`matchesSessionFilterByName` alongside existing exports.

Import in `src/mcp/mcp-server.ts` alongside existing `applySessionToolFilter` import (line ~78).

---

## Step 3: `src/mcp/mcp-server.ts` - Fix `applySessionToolFiltering`

**Location:** method body, after `const originalCount = this.profile.tools.length;` (~line 2747)

**Replace** the current deferred early-return block:
```typescript
// For upstream-only profiles (no local tools + upstream_mcp configured), skip pre-computation
// against an empty tools[]. An empty tools[] yields an empty allowedToolNames set, which would
// then block every upstream-discovered tool when the filter is consulted at tools/list and
// tools/call time. Instead, defer filter application to handleUpstreamToolsList where the
// actual upstream tool names are known. The raw request remains available via
// getSessionToolFilterRequest for lazy application there and at tools/call time.
if (originalCount === 0 && this.getUpstreamMcpConfig(profileId)?.length) {
  this.logger.debug('X-Mcp4-Tools filter deferred for upstream profile - will apply at tools/list time', {
    sessionId,
    patterns: request.rawEntries,
  });
  return;
}
```

**With** the fail-fast block:
```typescript
// For upstream proxy profiles (tools[] is empty, upstream_mcp configured):
// - Category rules require OpenAPI metadata unavailable for upstream tools - reject at init.
// - Exact/regex rules are pure name predicates; evaluated inline at tools/list and tools/call.
if (originalCount === 0 && this.getUpstreamMcpConfig(profileId)?.length) {
  if (request.allowCategories.size > 0) {
    throw new ValidationError(
      '_allow_list/_allow_read not supported for upstream proxy profiles. Use exact names or regex patterns instead.'
    );
  }
  // No pre-computation needed - predicate evaluated inline at tools/list and tools/call time.
  return;
}
```

---

## Step 3: `src/mcp/mcp-server.ts` - Fix `handleUpstreamToolsList`

**Location:** line ~1879, where `applyAndStoreUpstreamSessionFilter` is called.

**Replace:**
```typescript
      // Apply session-level X-Mcp4-Tools name filter (same gate as local tools/list).
      // For upstream profiles the filter was deferred at initialize time (applySessionToolFiltering
      // skips pre-computation when tools[] is empty). Apply it here against the actual discovered
      // tool names and store the result so subsequent tools/call invocations can enforce it.
      const nameFiltered = this.applyAndStoreUpstreamSessionFilter(
        policyFiltered, sessionId, profileId, provider.name);
```

**With:**
```typescript
      // Apply X-Mcp4-Tools filter as a pure name predicate against upstream-discovered tools.
      // Uses matchesSessionFilterByName (same abstraction as the local-tools path) - no
      // pre-computation or storage needed for upstream proxy profiles.
      const effectiveProfileIdForFilter = profileId || this.getProfileIdValue();
      const upstreamFilterRequest = typeof this.httpTransport?.getSessionToolFilterRequest === 'function'
        ? this.httpTransport.getSessionToolFilterRequest(effectiveProfileIdForFilter, sessionId)
        : undefined;
      const nameFiltered = upstreamFilterRequest?.hasRules
        ? policyFiltered.filter(t => matchesSessionFilterByName(upstreamFilterRequest, t.name))
        : policyFiltered;
```

---

## Step 4: `src/mcp/mcp-server.ts` - Fix `handleToolCall` (upstream path)

**Location:** lines ~1590-1597 (inside `if (upstreamMcpForCall?.length && this.getUpstreamClientFn)` block).

**Replace:**
```typescript
      // Apply tool filter (name-based) - same gate as local tools.
      // resolveToolFilterForSession handles the deferred-filter path for upstream profiles:
      // when no pre-computed filter exists (tools/list not yet called), it applies the raw
      // filter request directly against this tool name.
      const toolFilter = this.resolveToolFilterForSession(toolName, sessionId, profileId);
      if (toolFilter && !toolFilter.allowedToolNames.has(toolName)) {
        this.recordToolFilterRejection(toolName, 'session');
        const reason = toolFilter.reasons.get(toolName)?.[0];
        const reasonSuffix = reason ? ` Blocked by: ${reason}.` : '';
        return { jsonrpc: '2.0', id: req.id, error: { code: -32002, message: `Tool '${toolName}' not allowed by X-Mcp4-Tools filter.${reasonSuffix}` } };
      }
```

**With:**
```typescript
      // Apply X-Mcp4-Tools filter as a pure name predicate (upstream tools have no OpenAPI metadata).
      // Uses matchesSessionFilterByName for consistency with the local-tools filter path.
      if (sessionId && typeof this.httpTransport?.getSessionToolFilterRequest === 'function') {
        const upstreamFilterRequest = this.httpTransport.getSessionToolFilterRequest(
          profileId || this.getProfileIdValue(), sessionId
        );
        if (upstreamFilterRequest?.hasRules && !matchesSessionFilterByName(upstreamFilterRequest, toolName)) {
          this.recordToolFilterRejection(toolName, 'session');
          return { jsonrpc: '2.0', id: req.id, error: { code: -32002, message: `Tool '${toolName}' not allowed by X-Mcp4-Tools filter.` } };
        }
      }
```

Note: `reasonSuffix` is dropped - for upstream tools there are no pre-computed reasons.

---

## Step 6: `src/mcp/mcp-server.test.ts` - Remove 5 tests added in this session

Delete these entire `it(...)` blocks:

1. **Line ~3532**: `deferred X-Mcp4-Tools filter applies at tools/list time via getSessionToolFilterRequest`
2. **Line ~3934**: `deferred X-Mcp4-Tools filter blocks upstream tool call before tools/list is called`
3. **Line ~3952**: `deferred X-Mcp4-Tools filter allows matching upstream tool call before tools/list`
4. **Line ~2372**: `defers X-Mcp4-Tools filter for upstream_mcp profiles instead of storing empty filter`
5. Keep `does not throw for upstream profiles with empty tools[]...` (line ~2347) but revert
   the `getUpstreamMcpConfig: () => undefined` mock I added - restore original mock shape.

---

## Step 7: `src/mcp/mcp-server.test.ts` - Update 2 existing tests

### 6a. `X-Mcp4-Tools session filter removes blocked tools from upstream tools/list` (line ~3513)

This test currently mocks `getSessionToolFilter` (stored filter). New implementation uses
`getSessionToolFilterRequest` (raw request). Update:

**Replace mock:**
```typescript
(upstreamServer as any).httpTransport.getSessionToolFilter = () => ({
  allowedToolNames: new Set(['tool_a']),
  reasons: new Map([['tool_b', ['blocked by header']]]),
});
```

**With:**
```typescript
const filterRequest = parseSessionToolFilterHeader('tool_a');
(upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;
```

Test assertions stay identical (1 tool returned, name is `tool_a`).

### 6b. `tool filter blocks upstream tool call` (line ~3916)

Same issue - mocks `getSessionToolFilter`, needs `getSessionToolFilterRequest`.

**Replace mock:**
```typescript
(upstreamServer as any).httpTransport.getSessionToolFilter = () => ({
  allowedToolNames: new Set(['allowed_tool']),
  reasons: new Map([['safe_tool', ['blocked by filter']]]),
});
```

**With:**
```typescript
const filterRequest = parseSessionToolFilterHeader('allowed_tool');
(upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;
```

Test assertions stay identical (error, code -32002, message matches `/X-Mcp4-Tools filter/`).

---

## Step 8: `src/mcp/mcp-server.test.ts` - Add new tests

### 7a. In the `tool filter / auth helpers coverage` describe block (~line 2347)

Add after `does not throw for upstream profiles...`:

```typescript
it('throws ValidationError for _allow_list with upstream proxy profiles at session init', () => {
  const s = new MCPServer();
  (s as any).profile = {
    profile_name: 'upstream-test',
    tools: [],
    upstream_mcp: [{ name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } }],
  };
  const filterRequest = parseSessionToolFilterHeader('_allow_list');
  (s as any).httpTransport = {
    getSessionToolFilterRequest: () => filterRequest,
    getUpstreamMcpConfig: (_pid: string) =>
      [{ name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } }],
  };
  expect(() => (s as any).applySessionToolFiltering('session-1'))
    .toThrow('_allow_list/_allow_read not supported for upstream proxy profiles');
});

it('does not throw for exact/regex X-Mcp4-Tools rules with upstream proxy profiles at session init', () => {
  const s = new MCPServer();
  (s as any).profile = {
    profile_name: 'upstream-test',
    tools: [],
    upstream_mcp: [{ name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } }],
  };
  const filterRequest = parseSessionToolFilterHeader('tool_a, regex:read_.*');
  (s as any).httpTransport = {
    getSessionToolFilterRequest: () => filterRequest,
    getUpstreamMcpConfig: (_pid: string) =>
      [{ name: 'test', transport: { type: 'http', url: 'https://example.com/mcp' } }],
  };
  // Must not throw - exact/regex rules are deferred predicates for upstream
  expect(() => (s as any).applySessionToolFiltering('session-1')).not.toThrow();
});
```

### 7b. In the `tools/list upstream forwarding` describe block - after existing filter test

Add after the updated `X-Mcp4-Tools session filter removes blocked tools...` test:

```typescript
it('applies regex predicate X-Mcp4-Tools filter to upstream tools/list', async () => {
  const toolRead = { name: 'read_users', description: 'Read', inputSchema: { type: 'object', properties: {} } };
  const toolWrite = { name: 'write_users', description: 'Write', inputSchema: { type: 'object', properties: {} } };
  mockListTools.mockResolvedValueOnce({ tools: [toolRead, toolWrite] });
  const filterRequest = parseSessionToolFilterHeader('regex:read_.*');
  (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

  const response = await (upstreamServer as any).handleOtherRequest(
    { jsonrpc: '2.0', id: '1', method: 'tools/list', params: {} },
    'session-123',
    'upstream-profile',
  ) as any;

  expect(response.result.tools).toHaveLength(1);
  expect(response.result.tools[0].name).toBe('read_users');
});
```

### 7c. In `policy enforcement before upstream forwarding` describe block

Add after the updated `tool filter blocks upstream tool call` test:

```typescript
it('allows upstream tools/call when tool name matches X-Mcp4-Tools exact filter', async () => {
  const filterRequest = parseSessionToolFilterHeader('safe_tool');
  (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

  const response = await (upstreamServer as any).handleToolCall(
    { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
    'session-123',
    'upstream-profile',
  ) as any;

  expect(response.result).toBeDefined();
  expect(mockCallTool).toHaveBeenCalled();
});

it('blocks upstream tools/call when tool name does not match X-Mcp4-Tools regex filter', async () => {
  const filterRequest = parseSessionToolFilterHeader('regex:read_.*');
  (upstreamServer as any).httpTransport.getSessionToolFilterRequest = () => filterRequest;

  const response = await (upstreamServer as any).handleToolCall(
    { jsonrpc: '2.0', id: '1', method: 'tools/call', params: { name: 'safe_tool', arguments: {} } },
    'session-123',
    'upstream-profile',
  ) as any;

  expect(response.error).toBeDefined();
  expect(response.error.code).toBe(-32002);
  expect(response.error.message).toMatch(/X-Mcp4-Tools filter/);
  expect(mockCallTool).not.toHaveBeenCalled();
});
```

---

## Step 9: `CHANGELOG.md` - Update the entry added in this session

**Find and replace** the entry:
```
- `X-Mcp4-Tools` session filter now correctly applies to upstream proxy profiles: `applySessionToolFiltering` no longer pre-computes against an empty `tools[]` (which blocked all upstream tools); filter is applied at `tools/list` time against actual discovered tool names and enforced at `tools/call` via stored result or inline request evaluation.
```

**With:**
```
- `X-Mcp4-Tools` session filter now correctly applies to upstream proxy profiles: exact-name and regex rules are evaluated as inline predicates at `tools/list` and `tools/call` time; `_allow_list`/`_allow_read` category rules are rejected at session init with an actionable error (OpenAPI metadata unavailable for upstream tools).
```

---

## Step 10: Verification

```bash
npm run typecheck    # must be clean
npm test             # all tests must pass
```

Expected test count increase: net +3 tests (remove 5, add 8).

---

## Notes

- `matchesSessionFilterByName` accesses `exactNames` and `regexPatterns` fields which are defined in `SessionToolFilterRequest` (src/tool-filter/types.ts). This is the correct single place to access these internals - call sites use the utility, not the fields directly.
- `CompiledRegex` (from `filterRequest.regexPatterns`) has `.test(name: string): boolean` method - confirmed by usage in `RegexMatchRule`.
- `parseSessionToolFilterHeader` is already imported in `mcp-server.test.ts` (line 15).
- The `upstreamServer` test fixture already has `getSessionToolFilterRequest: () => undefined` in its `httpTransport` mock (line ~3379) - tests that override it just reassign the property.
- After this change, upstream proxy profiles have no concept of "stored session filter" for X-Mcp4-Tools - the raw `SessionToolFilterRequest` stored in `httpTransport` is the sole source of truth, evaluated inline at every tools/list and tools/call.
