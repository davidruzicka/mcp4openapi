# Technical Concerns & Debt

## High Priority

### 1. Monolithic MCP Server (`src/mcp/mcp-server.ts`)
- **Size:** 2700+ lines - violates single responsibility
- **Risk:** Hard to navigate, test, and extend
- **Tracked:** TODO.md #10 - planned split into focused modules
- **Impact:** Every new MCP capability adds to an already large file

### 2. Circular Dependency: MCPServer <-> HttpTransport
- **Location:** `src/mcp/mcp-server.ts` <-> `src/transport/http-transport.ts`
- **Risk:** Tight coupling, complicates testing and future refactoring
- **Tracked:** TODO.md #9 - refactor planned
- **Impact:** Cannot instantiate one without the other; limits modularity

### 3. Unbounded Profile Server Cache Growth
- **Location:** `src/transport/http-transport.ts` - `profileStates` Map
- **Risk:** Memory leak in long-running HTTP transport instances with many profiles
- **Tracked:** TODO.md #8 - LRU eviction needed
- **Impact:** Production server memory growth over time

## Medium Priority

### 4. Schema Synchronization Fragility (CRITICAL GOTCHA)
- **Three systems must stay in sync:** TypeScript types -> JSON Schema -> Zod
- **Risk:** Zod silently strips unknown fields - missing field = feature broken at runtime with no error
- **Mitigation:** `npm run check-schema-sync` exists but must be run manually
- **Impact:** Profile fields added to TypeScript but not regenerated = silent data loss

### 5. Profile Hint Collision Risk
- **Location:** `src/transport/http-transport.ts` - `profileHintsByClient` Map
- **Risk:** Client fingerprint collisions could route requests to wrong profile
- **Tracked:** TODO.md #12
- **TTL:** 10 min (`PROFILE_HINT_TTL_MS`) - mitigates but doesn't eliminate

### 6. ReDoS Protection Gaps in Tool Filtering
- **Location:** `src/tool-filter/` - regex-based tool name filtering
- **Risk:** User-supplied regex patterns could cause catastrophic backtracking
- **Tracked:** TODO.md #7 - input length bounding + safe regex needed
- **Impact:** DoS via malicious profile regex patterns

### 7. Query Parameter Redaction Canonicalization
- **Location:** Token redaction in logger + transport
- **Risk:** Non-canonical URL forms (double encoding, mixed case) may bypass redaction
- **Tracked:** TODO.md #4
- **Impact:** Token leakage in logs

## Low Priority / Known Limitations

### 8. `any` Type Casts Weakening Type Safety
- **Locations:** Scattered throughout codebase, especially in OpenAPI response handling
- **Risk:** Runtime errors not caught at compile time
- **Mitigation:** TypeScript strict mode catches most cases; `any` is localized

### 9. Node.js Version Split in CI
- **Main CI:** Node.js 20; **Implementor pipeline:** Node.js 22
- **Risk:** Inconsistency; `ts-json-schema-generator` 2.5.0 requires Node 22
- **Tracked:** Issue #224 - align all CI to Node.js 22
- **Impact:** Schema generation would fail on Node 20

### 10. OpenAPI `$ref` Resolution Incomplete
- **Location:** `src/openapi/openapi-parser.ts`
- **Note:** `$ref` resolved for parameters but not full schema resolution
- **Impact:** Complex nested `$ref` in request bodies may not resolve correctly

### 11. OAuth Session Extended TTL vs Static Token
- **OAuth sessions:** 24h default TTL
- **Static token sessions:** 30min TTL
- **Risk:** Long-lived OAuth sessions increase window for token replay if compromised

## Open PRs with Potential Conflicts

Several long-running open PRs may conflict with new features:
- #219 - upstream MCP provider config schema
- #170 - tool-filter service factory refactor
- #168 - security host/CIDR allowlist matcher
- #166, #149, #145 - HTTP transport cache bounding (related to Concern #3)
- #156 - narrow HTTP transport boundary (related to Concern #2)
- #151 - query redaction canonicalization (related to Concern #7)
- #164, #158 - security fixes (SSRF, OAuth redirect schemes)

## Security Concerns (Sentinel PRs Pending)

- #221 - SSRF in SessionCookieAuthManager (HIGH)
- #209 - Internal error leakage in MCP server handlers (MEDIUM)
- #206 - Error message leakage in JSON-RPC handlers (MEDIUM)
- #201 - SSRF in EnterpriseAuthProvider discovery fetch (HIGH)
- #176 - Internal error leakage via prompts and resources (CRITICAL)
- #171 - Missing correlation IDs in 500 API responses (MEDIUM)
- #225 - Missing security headers (improvement)
