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
  - [6. Improve project_id encoding](#6-improve-project_id-encoding)

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

### 6. Improve project_id encoding
**Problem**: Path parameters such as `project_id` are always URL-encoded by `encodePathSegment()`. If callers pass values that already contain URL-encoded segments (e.g. `group/mcp%2Fapp`), the current logic double-encodes them (`%25`). GitLab then fails to resolve the project.

**Goal**: Accept combined identifiers and encode missing parts only without double-encoding or throw error message with clear guidance.

**Ideas** (need evaluation):
- Detect existing `%` sequences and attempt `decodeURIComponent` before deciding whether to re-encode.
- Replace `/` characters only with `%2F`.

**Estimated effort**: 1-2 hours
