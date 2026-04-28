---
phase: 02-tool-discovery-and-call-proxy
plan: 02
subsystem: api
tags: [mcp, proxy, upstream, tools, sanitization, error-mapping]

# Dependency graph
requires:
  - phase: 02-01
    provides: UpstreamConnectionManager, sanitizeToolList, upstream error classes, HttpTransport.setUpstreamConnectionManager
provides:
  - handleUpstreamToolsList method in MCPServer routing tools/list to upstream MCP server
  - handleUpstreamToolCall method in MCPServer routing tools/call to upstream MCP server
  - mapUpstreamErrorToMcpError data-driven error mapping with instanceof dispatch
  - sessionId guard preventing runtime crash on stdio transport with upstream_mcp
  - capabilities advertising tools.listChanged:true when upstream_mcp configured
  - getUpstreamMcpConfig public accessor on HttpTransport
  - setGetUpstreamClient injection point on MCPServer for wiring upstream client factory
affects: [02-03, downstream capability negotiation, error taxonomy]

# Tech tracking
tech-stack:
  added: [ErrorCode from @modelcontextprotocol/sdk/types.js]
  patterns:
    - DATA_DRIVEN_MAPPINGS array with instanceof dispatch (not constructor.name string matching)
    - Callback injection for upstream client access (avoids circular dependency)
    - Provider name in error.data only, not in client-facing message string
    - sessionId guard at entry of every upstream handler method

key-files:
  created: []
  modified:
    - src/mcp/mcp-server.ts
    - src/transport/http-transport.ts
    - src/mcp/mcp-server.test.ts

key-decisions:
  - "Callback injection (setGetUpstreamClient) rather than direct UpstreamConnectionManager import in MCPServer avoids circular dependency and keeps the module boundary clean"
  - "Provider name placed in error.data.providerName only - not in the client-facing message string - to prevent infrastructure name leakage at the security boundary"
  - "UPSTREAM_TIMEOUT_ERROR_CODE = -32001 named constant used instead of inline magic number"
  - "sessionId guard throws UpstreamConnectionError (not a silent no-op) for stdio with upstream_mcp - fails fast with a clear message"

patterns-established:
  - "Upstream branching check always guards with both config presence AND client fn: `upstreamMcp?.length && this.getUpstreamClientFn`"
  - "handleUpstreamToolsList wraps the entire getOrConnect+listTools flow in try/catch - returns MCP error response, not unhandled rejection"
  - "isError:true from upstream is returned in result field, never converted to JSON-RPC error"

requirements-completed: [PROXY-03, PROXY-04, SEC-01]

# Metrics
duration: 8min
completed: 2026-03-30
---

# Phase 02 Plan 02: Upstream tools/list and tools/call proxy handlers Summary

**tools/list and tools/call in MCPServer branch to upstream MCP server with sanitizeToolList, instanceof-based error mapping, sessionId guard, and listChanged capability advertisement**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-30T14:00:00Z
- **Completed:** 2026-03-30T14:08:39Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- tools/list branches to upstream when upstream_mcp configured and client fn is wired; response sanitized via sanitizeToolList
- tools/call forwards to upstream; isError:true results forwarded as-is; thrown exceptions mapped via data-driven instanceof dispatch
- sessionId guard in both handlers prevents non-null assertion crash on stdio transport
- Capabilities advertise tools.listChanged:true when upstream_mcp is configured
- 14 unit tests covering all required behaviors (all green)

## Task Commits

1. **Task 1: Upstream tools/list and tools/call handler methods + error mapping + capabilities** - `552b03e` (feat)
2. **Task 2: Unit tests for upstream handler branching, sanitization integration, and error mapping** - `65e4481` (test)

## Files Created/Modified
- `src/mcp/mcp-server.ts` - Added handleUpstreamToolsList, handleUpstreamToolCall, mapUpstreamErrorToMcpError, getUpstreamMcpConfig, getUpstreamToken, setGetUpstreamClient, UPSTREAM_TIMEOUT_ERROR_CODE, upstream branching in tools/list and tools/call handlers, listChanged capability
- `src/transport/http-transport.ts` - Added getUpstreamMcpConfig public accessor and UpstreamMcpServerConfig import
- `src/mcp/mcp-server.test.ts` - Added 14 upstream proxy tests covering all plan behaviors

## Decisions Made
- Callback injection via `setGetUpstreamClient` used instead of direct reference to UpstreamConnectionManager to avoid circular dependency between mcp-server.ts and http-transport.ts
- Provider name kept out of client-facing error message; placed in error.data only
- `UpstreamConnectionError` constructor signature is `(message, providerName, extras?)` - plan's pseudocode used a different signature; adapted to match actual implementation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Adapted UpstreamConnectionError constructor call to actual signature**
- **Found during:** Task 1 (sessionId guard implementation)
- **Issue:** Plan pseudocode showed `new UpstreamConnectionError(message, { correlationId })` but actual constructor is `(message, providerName, extras?)`
- **Fix:** Used `new UpstreamConnectionError('upstream_mcp requires a session context (HTTP transport only)', provider.name)` matching actual class
- **Files modified:** src/mcp/mcp-server.ts
- **Verification:** TypeScript compiles with no errors
- **Committed in:** 552b03e (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - constructor signature mismatch)
**Impact on plan:** Required for correct operation. No scope creep.

## Issues Encountered
- 3 pre-existing test failures in `src/profile/profile-loader.test.ts` (tests use upstream_mcp alongside tools[] which violates D-02 mutual exclusivity from Plan 02-01). These failures existed before any changes in this plan and are out of scope. Documented in deferred-items.

## Stubs
None - all functionality fully wired. The getUpstreamClientFn callback defaults to null and requires external wiring via `setGetUpstreamClient` - this is intentional design (injection pattern), not a stub.

## Next Phase Readiness
- Upstream proxy core behavior complete (PROXY-03 + PROXY-04)
- setGetUpstreamClient needs to be called from production entry point alongside setUpstreamConnectionManager
- Plan 02-03 (notification forwarding) can proceed

---
*Phase: 02-tool-discovery-and-call-proxy*
*Completed: 2026-03-30*
