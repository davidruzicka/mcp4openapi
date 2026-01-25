# TODO

**Note**: This contains future work (P1/P2/P3).

---

## Contents

- [P1: Correctness and Core Features](#p1-correctness-and-core-features)
  - [1. Validate Operations Against OpenAPI Spec in ProfileLoader](#1-validate-operations-against-openapi-spec-in-profileloader)
- [P2: Nice-to-Have](#p2-nice-to-have)
  - [2. Export Profile Command](#2-export-profile-command)
  - [3. OpenAPI Operation Filter for Default Profile](#3-openapi-operation-filter-for-default-profile)
  - [4. Response Caching](#4-response-caching)
  - [5. Request Deduplication](#5-request-deduplication)
  - [7. Strengthen ReDoS Protection in Regex Compiler](#7-strengthen-redos-protection-in-regex-compiler)
  - [8. Limit HTTP profile server cache growth](#8-limit-http-profile-server-cache-growth)
  - [9. Break MCPServer-HttpTransport circular dependency](#9-break-mcpserver-httptransport-circular-dependency)
  - [10. Split HttpTransport into smaller modules](#10-split-httptransport-into-smaller-modules)
  - [11. Reduce usage of any casts in HTTP transport](#11-reduce-usage-of-any-casts-in-http-transport)

## P1: Correctness and Core Features

### 1. Validate Operations Against OpenAPI Spec in ProfileLoader
**Current**: Profile validation only checks internal consistency (operation keys match action enum). Validation against actual OpenAPI spec operations happens only in `scripts/validate-profile.ts`, not at runtime in `ProfileLoader`.

**Goal**: Catch invalid operationIds at profile load time, not at first tool execution.

**Implementation**:
- In `ProfileLoader.load()`, accept optional `OpenAPIParser` parameter
- After `validateLogic()`, validate each `operationId` in `tool.operations` exists in OpenAPI spec
- Validate composite step `call` values exist as operations
- Provide helpful error: "Operation 'getProjects' in tool 'project_tool' not found in OpenAPI spec. Available operations: getProject, listProjects, ..."

**Files to modify**:
- `src/profile-loader.ts` - add `validateOperations(parser: OpenAPIParser)` method
- `src/mcp-server.ts` - pass parser to ProfileLoader

**Estimated effort**: 1-2 hours

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

### 4. Response Caching
Add optional caching layer for idempotent GET requests:
```json
{
  "interceptors": {
    "cache": {
      "enabled": true,
      "ttl_seconds": 300,
      "max_entries": 1000
    }
  }
}
```

**Estimated effort**: 3-4 hours

### 5. Request Deduplication
Prevent multiple identical in-flight requests (thundering herd):
- Hash request (method + URL + body)
- If same request is pending, await existing promise
- Return cached result to all callers

**Estimated effort**: 2-3 hours

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
