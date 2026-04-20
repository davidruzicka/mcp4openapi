# TODO

**Note**: This contains future work (P1/P2/P3).

---

## Contents

- [P2: Nice-to-Have](#p2-nice-to-have)
  - [2. Export Profile Command](#2-export-profile-command)
  - [3. OpenAPI Operation Filter for Default Profile](#3-openapi-operation-filter-for-default-profile)
  - [10. Split HttpTransport into smaller modules](#10-split-httptransport-into-smaller-modules)
  - [11. Reduce usage of any casts in HTTP transport](#11-reduce-usage-of-any-casts-in-http-transport)
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
