# TODO

**Note**: This contains future work (P1/P2/P3).

---

## Contents

- [P2: Nice-to-Have](#p2-nice-to-have)
  - [2. Export Profile Command](#2-export-profile-command)
  - [3. OpenAPI Operation Filter for Default Profile](#3-openapi-operation-filter-for-default-profile)
  - [4. Harden query parameter redaction canonicalization](#4-harden-query-parameter-redaction-canonicalization)
  - [7. Strengthen ReDoS Protection in Regex Compiler](#7-strengthen-redos-protection-in-regex-compiler)
  - [8. Limit HTTP profile server cache growth](#8-limit-http-profile-server-cache-growth)
  - [9. Break MCPServer-HttpTransport circular dependency](#9-break-mcpserver-httptransport-circular-dependency)
  - [10. Split HttpTransport into smaller modules](#10-split-httptransport-into-smaller-modules)
  - [11. Reduce usage of any casts in HTTP transport](#11-reduce-usage-of-any-casts-in-http-transport)
  - [12. Avoid HTTP profile hint collisions across shared IPs](#12-avoid-http-profile-hint-collisions-across-shared-ips)
  - [13. Prevent unbounded growth of HTTP profile hint cache](#13-prevent-unbounded-growth-of-http-profile-hint-cache)
  - [14. Consider strict OAuth redirect scheme allowlist](#14-consider-strict-oauth-redirect-scheme-allowlist)
  - [16. Extract tenant session lifecycle from HttpTransport](#16-extract-tenant-session-lifecycle-from-httptransport)

## P2: Nice-to-Have

### 2. Export Profile Command
**Goal**: Allow exporting auto-generated profile to file/stdout instead of using it directly.

**Use cases**:
- Generate starter profile for manual customization
- Debug auto-generation logic
- Version control profile alongside OpenAPI spec
- Share profiles between team members

**Implementation**:
```bash
# Export to file
mcp4openapi export-profile \
  --openapi-spec-path=api.yaml \
  --mcp-profile-path=profile.json \
  --mcp-toolname-strategy=balanced \
  --mcp-toolname-max=45 \
  --mcp-toolname-min-parts=3 \
  --mcp-toolname-min-length=20

# Export to stdout (for piping)
mcp4openapi export-profile --openapi-spec-path=api.yaml
```

**Technical approach**:
- Reuse existing `ProfileLoader.createDefaultProfile()` - no duplication!
- Add CLI command parser (yargs or commander)
- Add `src/cli-export.ts` for export logic
- Support all naming strategies and options
- Format JSON with 2-space indent

**Files to modify**:
- `src/cli-export.ts` (new) - export command implementation
- `src/index.ts` - add command routing
- `package.json` - add bin command `mcp4openapi-export`
- `README.md` - document export command

**Estimated effort**: 1-2 hours (mostly CLI parsing and formatting)

**Note**: This command could include auto-detection of probe endpoints for token validation in future versions.

### 3. OpenAPI Operation Filter for Default Profile
**Current**: Without profile, all OpenAPI operations generate tools. Complex APIs may produce 100+ tools with parameter inflation warnings.

**Goal**: Allow filtering operations when auto-generating default profile.

**Implementation Options**:

**Option A: Whitelist (Simple, Recommended for Start)**
```bash
export DEFAULT_PROFILE_ALLOWED_OPERATIONS="getProject,listProjects,createIssue"
```

**Pros**: Simple, deterministic, easy to audit
**Cons**: Requires maintenance when API changes

**Option A2: Regex Whitelist (Flexible)**
```bash
export DEFAULT_PROFILE_OPERATIONS_REGEX="^(get|list|create)"
# Example: only read operations
export DEFAULT_PROFILE_OPERATIONS_REGEX="^(get|list|search)"
# Example: exclude delete operations
export DEFAULT_PROFILE_OPERATIONS_REGEX="^(?!delete)"
```

**Pros**: Flexible, covers operation classes, adapts to API changes
**Cons**: Risk of unintended matches, harder to audit

**Option B: Blacklist (Exclusion-based)**
```bash
export DEFAULT_PROFILE_EXCLUDE_OPERATIONS="deleteProject,deleteIssue"
export DEFAULT_PROFILE_EXCLUDE_TAGS="admin,deprecated"
```

**Pros**: Include most, exclude specific dangerous operations

### 4. Harden query parameter redaction canonicalization
**Current**: `redactQueryParam()` supports exact key matching and now covers dot-separated parameter names, but standard URL parsing and fallback/manual parsing do not explicitly share one canonicalization strategy for encoded query keys or equivalent key spellings.

**Goal**: Keep query-parameter redaction deterministic across parser paths and reduce the risk of log leakage when sensitive keys appear in percent-encoded or otherwise equivalent forms.

**Implementation**:
- Define one canonicalization strategy for query parameter keys before comparison.
- Align `new URL()` handling and manual fallback handling so both paths redact the same keys.
- Add explicit tests for percent-encoded query keys and parser-path consistency.
- Keep the implementation bounded and regex-safe; do not introduce heuristic fuzzy matching.

**Files to modify**:
- `src/validation/validation-utils.ts`
- `src/validation/validation-utils.test.ts`

**Estimated effort**: 1-2 hours
**Cons**: May miss new dangerous operations

**Option C: Tag-based Filter (Leverages OpenAPI Tags)**
```bash
export DEFAULT_PROFILE_INCLUDE_TAGS="projects,issues,merge_requests"
export DEFAULT_PROFILE_EXCLUDE_TAGS="admin,system"
```

**Pros**: Semantic filtering aligned with API design
**Cons**: Requires well-tagged OpenAPI spec

**Recommendation**: 
- **Production/Security-critical**: Use **Option A (whitelist)** for explicit control
- **Development/Exploration**: Use **Option A2 (regex)** for flexibility
- **Well-documented APIs**: Add **Option C (tag-based)** for semantic filtering
- **Combination**: Support all three simultaneously (whitelist + regex + tags) with precedence: whitelist → regex → tags

**Files to modify**:
- `src/profile-loader.ts` - filter operations in `createDefaultProfile()`
- `README.md` - document env variables

**Estimated effort**:
- Whitelist: 1 hour
- Regex: 1 hour
- Tag-based: 1-2 hours
- Total (all three): 3-4 hours

### 7. Strengthen ReDoS Protection in Regex Compiler
**Problem**: `RegexCompiler` accepts user input from HTTP headers (`X-Mcp4-Tools`) and environment variables. While `RegexValidator` provides partial protection (length limits, nested quantifiers, ambiguous alternation), it doesn't cover all ReDoS attack vectors. A malicious user could craft regex patterns that pass validation but still cause exponential backtracking.

**Current protection**:
- Max length: 100 characters (configurable)
- Nested quantifiers detection: `(a+)+`, `(x*)*`, etc.
- Ambiguous alternation detection: `(a|aa)+`, `(foo|foobar)*`, etc.

**Gaps**:
- Other ReDoS patterns may pass validation
- No timeout for regex matching operations
- No limit on input length being tested against regex

**Goal**: Strengthen ReDoS protection to prevent DoS attacks via malicious regex patterns.

**Implementation options**:

**Option A: Add Regex Matching Timeout (Recommended)**
- Use worker threads or `piscina` to run regex matches with timeout
- Kill worker if match exceeds threshold (e.g., 100ms)
- Fallback to rejection if timeout occurs

**Option B: Expand Validation Patterns**
- Add detection for more ReDoS patterns (e.g., overlapping alternations, complex nested groups)
- Use regex analysis libraries (e.g., `safe-regex`, `redos-detector`)

**Option C: Limit Test Input Length**
- Restrict length of strings tested against compiled regex
- Tool names are naturally limited, but add explicit check in `CompiledRegex.test()`

**Recommendation**: Implement **Option A** (timeout) + **Option C** (input length limit) for defense in depth. Option B can be added incrementally.

**Files to modify**:
- `src/tool-filter/regex/regex-compiler.ts` - add timeout wrapper for regex matching
- `src/tool-filter/regex/regex-validator.ts` - expand pattern detection (optional)
- `src/tool-filter/regex/regex-compiler.test.ts` - add timeout and edge case tests

**Estimated effort**: 2-3 hours (timeout implementation) + 1-2 hours (expanded validation)

### 8. Limit HTTP profile server cache growth
**Problem**: HTTP profile routing keeps every requested profile's MCPServer initialized indefinitely. With many large OpenAPI specs, this can exhaust memory.

**Goal**: Add basic eviction or caps for profile server instances to bound memory usage.

**Implementation options**:
- TTL eviction: expire inactive profiles after `MCP4_PROFILE_CACHE_TTL_MS`.
- Max size: cap servers to `MCP4_PROFILE_CACHE_MAX` with LRU eviction.
- Combine TTL + max size with soft warnings when evicting.

**Files to modify**:
- `src/mcp-server-manager.ts` - eviction logic and tracking
- `src/index.ts` - pass env config into manager/registry
- `README.md` - document new env vars

**Estimated effort**: 2-4 hours

### 9. Break MCPServer-HttpTransport circular dependency
**Problem**: MCPServer holds a reference to HttpTransport (typed as any), creating a circular dependency and weaker type safety.

**Goal**: Remove direct dependency between MCPServer and HttpTransport for session cleanup and related hooks.

**Implementation options**:
- Introduce a small transport interface (methods used by MCPServer only) and type against that.
- Use event-based cleanup: MCPServer emits session cleanup events, HttpTransport subscribes.
- Invert control: move cleanup trigger into HttpTransport and pass a callback instead of full transport instance.

**Files to modify**:
- `src/mcp-server.ts` - replace direct transport reference with interface/callback
- `src/http-transport.ts` - adjust session cleanup hookup
- `src/mcp-server-manager.ts` - wiring changes if needed
- `README.md` or `IMPLEMENTATION.md` - document architecture change

**Estimated effort**: 2-3 hours

### 10. Split HttpTransport into smaller modules
**Problem**: `src/http-transport.ts` is >2700 lines. `setupRoutes` and related OAuth/MCP handlers are large and hard to maintain.

**Goal**: Improve maintainability by splitting HttpTransport into focused modules with clear responsibilities.

**Implementation options**:
- Extract OAuth handlers to `src/http/oauth-handler.ts` (authorize, token, callback, metadata).
- Extract MCP route setup to `src/http/mcp-router.ts` (POST/GET/DELETE + SSE).
- Keep core transport state in `src/http-transport.ts` and delegate route registration.

**Files to modify**:
- `src/http-transport.ts` - delegate to new modules
- new module files under `src/http/`
- `IMPLEMENTATION.md` - architecture update (if needed)

**Estimated effort**: 3-5 hours

### 11. Reduce usage of any casts in HTTP transport
**Problem**: `as any` casts have grown, especially in `src/http-transport.ts` and related unit tests, weakening type safety.

**Goal**: Replace `any` casts with explicit interfaces or type guards where practical.

**Implementation options**:
- Introduce small internal interfaces for private helper shapes used in tests.
- Add type guards for request/response mocks in unit tests.
- Replace `any` in `HttpTransport` signatures with typed callbacks or narrow types.

**Files to modify**:
- `src/http-transport.ts`
- `src/http-transport.unit.test.ts`
- `src/http-transport.test.ts`

**Estimated effort**: 2-4 hours

### 12. Avoid HTTP profile hint collisions across shared IPs
**Problem**: Profile hint keys are derived from IP and user-agent only, so different clients behind the same NAT with identical user agents can overwrite each other's hints. This can misroute profile resolution for OAuth endpoints or origin checks when profile routing has no default profile.

**Goal**: Make profile hint association more robust to shared IPs and identical user-agent strings.

**Implementation options**:
- Include additional request entropy in the key (e.g., TLS session ID, `X-Forwarded-For` chain hash, or a server-generated hint cookie).
- Set a hint cookie on first profile-routed request and use that as the primary key.
- Add a short-lived per-profile routing token embedded in OAuth metadata links.

**Files to modify**:
- `src/http-transport.ts` - profile hint keying and lookup logic
- `docs/HTTP-TRANSPORT.md` - document new hint mechanism (if user-facing)

**Estimated effort**: 2-4 hours

### 13. Prevent unbounded growth of HTTP profile hint cache
**Problem**: Profile hints are stored per client but only cleaned up on subsequent lookups, so many one-off clients can cause the cache to grow without bound in long-running servers.

**Goal**: Bound memory usage for profile hint cache.

**Implementation options**:
- Periodic cleanup timer that removes expired hints.
- Cap the cache size with LRU eviction.
- Combine TTL + size cap with logging when evictions occur.

**Files to modify**:
- `src/http-transport.ts` - add cache eviction or cleanup
- `README.md` - document any new env vars or limits

**Estimated effort**: 1-2 hours

### 14. Consider strict OAuth redirect scheme allowlist
**Current**: `ExternalOAuthProvider` uses a denylist for dangerous redirect URI schemes (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`) while keeping compatibility with custom client schemes.

**Goal**: Evaluate migrating to a strict allowlist-based scheme policy for stronger security guarantees.

**Implementation options**:
- Add `allowed_redirect_schemes` to OAuth profile config with secure defaults (`http`, `https`) and explicit custom scheme opt-in.
- Keep denylist as fallback behavior during migration to avoid breaking existing clients.
- Add compatibility tests for common deep-link clients and document migration guidance.

**Files to modify**:
- `src/types/profile.ts` - OAuth config type extension
- `src/auth/oauth-provider.ts` - scheme validation logic
- `src/auth/oauth-provider.test.ts` - allowlist and migration tests
- `docs/OAUTH.md` and `README.md` - configuration guidance

**Estimated effort**: 2-4 hours

### 16. Extract tenant session lifecycle from HttpTransport
**Problem**: `HttpTransport` currently combines routing, auth, filtering, SSE/session control, and tenant-specific session state/lifecycle (`tenantOAuthProvidersBySessionId`, tenant selector consistency checks, tenant context hydration). This concentration increases coupling and regression risk.

**Goal**: Move tenant session responsibilities into a dedicated service while keeping transport behavior unchanged.

**Implementation options**:
- Introduce `TenantSessionService` (or `SessionManager` with tenant-focused submodule) to own:
  - tenant context selection/validation for initialize and non-initialize requests
  - session-level tenant OAuth provider map lifecycle (create/get/cleanup)
  - tenant header immutability checks and error mapping
- Keep `HttpTransport` as orchestrator only (HTTP parsing/routing + delegation).
- Add small interfaces for session store access to avoid introducing new circular dependencies.

**Files to modify**:
- `src/transport/http-transport.ts`
- `src/transport/http-tenant-config.ts` (reuse and tighten public API boundaries)
- `src/transport/http-transport.test.ts`
- optional new module(s): `src/transport/tenant-session-service.ts`

**Estimated effort**: 3-5 hours
