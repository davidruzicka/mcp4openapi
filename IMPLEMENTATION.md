# Implementation Summary

## Architecture

```
┌─────────────────┐
│  CLI Entry      │  index.ts - reads env vars, initializes server
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  MCP Server     │  src/mcp/mcp-server.ts - coordinates all components
└────────┬────────┘
         │
         ├──────────► OpenAPI Parser (src/openapi/openapi-parser.ts)
         │            - Loads & indexes OpenAPI spec
         │            - Resolves $ref parameters
         │            - Fast operation lookup
         │
         ├──────────► Profile Loader (src/profile/profile-loader.ts)
         │            - Validates profile JSON with Zod (auto-generated)
         │            - Checks semantic rules
         │            - Default profile generation
         │            - Zod schemas auto-generated from TypeScript types
         │
         ├──────────► Tool Generator (src/tooling/tool-generator.ts)
         │            - Generates MCP tools from profile
         │            - Creates JSON Schema for parameters
         │            - Validates conditional requirements
         │            - Maps actions to operations
         │
         ├──────────► HTTP Client + Interceptors (src/transport/interceptors.ts)
         │            - Auth (bearer/query/custom-header/session-cookie)
         │            - Rate limiting (token bucket)
         │            - Retry (exponential backoff)
         │            - Fetch wrapper
         │
         ├──────────► Tool Filter Service (tool-filter/)
         │            - Modular filtering architecture
         │            - Global filtering (env vars)
         │            - Session filtering (HTTP headers)
         │            - ReDoS protection & validation
         │
         └──────────► Composite Executor (src/tooling/composite-executor.ts)
                      - Chains API calls
                      - Merges results into nested structure
                      - Path parameter resolution
```

## Key Design Decisions

### 1. Tool Filtering Architecture

**Why**: Allow runtime tool filtering for security, performance, and customization.

**Implementation**:
- **Modular Design**: 15+ focused modules replacing monolithic 648-line file
- **Strategy Pattern**: Pluggable filter rules (Exact, Regex, Category)
- **Facade Pattern**: ToolFilterService orchestrates all components
- **ReDoS Protection**: Validates regex patterns for safety (nested quantifiers, alternations)
- **Unicode Normalization**: NFC normalization for consistent matching
- **Compatibility Layer**: Legacy API preserved through compat.ts wrappers

**Module Structure**:
```
tool-filter/
├── types.ts              - Shared type definitions
├── errors.ts             - Custom error classes
├── utils.ts              - Utility functions (normalizeToolName)
├── compat.ts             - Backward compatibility wrappers
├── regex/
│   ├── regex-validator.ts   - ReDoS pattern detection
│   └── regex-compiler.ts    - Auto-anchoring compiler
├── operation/
│   ├── operation-classifier.ts - Classify operations (list/read/modify)
│   ├── operation-resolver.ts   - Strong operation lookup interface
│   └── operation-detector.ts   - Detect tool categories
├── filter/
│   ├── filter-rules.ts      - Strategy pattern implementations
│   ├── filter-engine.ts     - Rule orchestration with precedence
│   ├── global-tool-filter.ts   - Environment-based filtering
│   └── session-tool-filter.ts  - HTTP header-based filtering
├── config/
│   ├── env-config-parser.ts    - Parse MCP4_TOOL_FILTER_* vars
│   └── header-config-parser.ts - Parse X-Mcp4-Tools header
└── integration/
    └── tool-filter-service.ts  - Facade for all filtering
```

**Components**:
- **EnvConfigParser**: Parses MCP4_TOOL_FILTER_* environment variables with validation
- **HeaderConfigParser**: Parses X-Mcp4-Tools HTTP header (255 char limit, 100 entries max)
- **FilterEngine**: Applies rules with precedence (deny > allow)
- **GlobalToolFilter**: Environment-based filtering with logging and summaries
- **SessionToolFilter**: Per-session HTTP header filtering
- **OperationClassifier**: Categorizes operations (list/read/modify) based on HTTP method and params
- **OperationDetector**: Detects categories for simple and composite tools
- **ToolFilterService**: Facade that orchestrates all filtering components

**Key Features**:
- **ReDoS Protection**: Detects unsafe patterns (nested quantifiers, ambiguous alternation)
- **Auto-anchoring**: Automatically adds ^ and $ to regex patterns
- **Unicode Support**: NFC normalization ensures "café" matches "café" (composed vs decomposed)
- **Category Filtering**: Allow only list/read operations (e.g., `_allow_list`, `_allow_read`)
- **Composite Tool Support**: Detects categories for multi-step composite tools
- **Session Filtering**: Per-session tool filtering via X-Mcp4-Tools HTTP header
- **Backward Compatibility**: Legacy API preserved through compat.ts wrappers

**Trade-offs**:
- More modules (15+) vs simpler monolithic design
- Better testability (each module independently testable)
- Easier to extend (new rules via Strategy pattern)
- Minimal performance overhead (+5ms initialization, lazy loaded)
- Clean separation of concerns (parsing, filtering, detection)

### 2. Configuration-Driven Design

**Why**: Same server code works with any API. All customization in profile JSON.

**Implementation**:
- **Parameter Aliases**: Map tool parameters to API path params (e.g., `resource_id` → `{id}`)
- **Metadata Params**: Specify which parameters control tool behavior vs API request
- **Array Format**: Configure array serialization per API (brackets, indices, repeat, comma)
- **Partial Results**: Composite tools can return completed steps even if later steps fail
- **Profile-Aware Token Redaction**: Logger automatically redacts auth credentials based on profile auth type (bearer/query/custom-header/session-cookie)
- **Explicit Shared Cache Override**: `allow_shared_with_auth` keeps auth-aware cache safety by default while allowing explicitly shared public cache entries for responses that are identical across callers

**Trade-offs**:
- More upfront configuration vs runtime flexibility
- Validation at profile load time catches errors early
- No hard-coded API assumptions in core code

### 3. Tool Aggregation Strategy

**Why**: Reduce MCP tool count from 200+ to ~5-10

**How**:
- `manage_project_badges` → 5 CRUD operations
- `manage_branches` → 7 operations
- `manage_access_requests` → 8 operations (project + group)

**Trade-off**:
- Massive reduction in tool count
- Less context pollution for LLM
- ⚠️ Slightly more complex parameter validation

### 4. Profile-Driven Configuration

**Why**: Same server, different tool surfaces without code changes

**How**: JSON profiles define:
- Which tools to expose
- How actions map to operations
- Resource type discrimination (project/group)
- Interceptor configuration

**Benefits**:
- Admin profile: full access
- Developer profile: read/write, no admin ops
- Readonly profile: only GET operations

### 5. Multi-Profile Selection and Routing

**Why**: Support multiple profiles in one deployment and enable profile-specific MCP endpoints.

**How**:
- **CLI profile selection**: `--profile <id>` resolves a profile JSON and OpenAPI spec from a profiles directory.
- **Profile registry**: `ProfileRegistry` discovers and resolves profiles using `profile_id`, `profile_name`, and `profile_aliases`.
- **Server manager**: `MCPServerManager` lazily initializes a server per profile and caches instances.
- **HTTP profile routing**: `/profile/:profileId/mcp` routes requests to the correct server when enabled with `MCP4_HTTP_PROFILE_ROUTING=true`.
- **Routing allowlist**: `MCP4_ALLOW_PROFILES` and `MCP4_ALLOW_PROFILES_REGEX` restrict which profiles are routable.
- **Default profile behavior**: `/mcp` remains available only when a default profile is configured (via `MCP4_PROFILE_PATH` or `--profile-path`).
- **OAuth metadata per profile**: `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` are available under `/profile/:profileId/` when routing is enabled.

### 6. Conditional Parameter Requirements

**Why**: `badge_id` only needed for get/update/delete, not list/create

**How**:
- `required_for: ["get", "update", "delete"]` for conditional required inputs
- `allowed_for: [...]` and `forbidden_for: [...]` for explicit action-level parameter gating
- `enum_for: { action: [...] }` for action-specific enum constraints

**LLM-friendly**: Description includes conditional hints for required/allowed/forbidden actions.

**Validation**:
- Profile-load validation checks action references and contradictory rule combinations.
- Runtime check in `validateArguments()` blocks invalid action/parameter combinations before API call.

### 7. Interceptor Chain Pattern

**Why**: Separate auth, rate-limiting, retry concerns from business logic

**How**: Middleware pattern with `next()` chain

**Order**: auth → rate-limit → retry → fetch

**Benefits**:
- Each interceptor independently testable
- Easy to add new interceptors (logging, metrics)
- Configuration-driven (no code changes)

### 8. Composite Tools for Reducing Roundtrips

**Why**: Fetching MR + comments + changes requires 3 calls

**How**: `steps` array with `store_as` JSONPath for result aggregation

**Example**:
```json
{
  "steps": [
    { "call": "GET /projects/{id}/merge_requests/{iid}", "store_as": "merge_request" },
    { "call": "GET /projects/{id}/merge_requests/{iid}/notes", "store_as": "merge_request.comments" }
  ]
}
```

**Result**: Single JSON with nested structure

### 9. $ref Resolution in OpenAPI

**Why**: GitLab spec uses shared parameters (`ProjectIdOrPath`)

**How**: `resolveParameter()` looks up in `components.parameters`

**Impact**: Properly extracts `id` path parameter that was previously missed

### 10. Resource Type Discrimination

**Why**: Same operation on different resources (project badges vs group badges)

**How**: `resource_type` parameter + operation mapping:
```json
{
  "operations": {
    "list_project": "getApiV4ProjectsIdBadges",
    "list_group": "getApiV4GroupsIdBadges"
  }
}
```

**Lookup**: `mapActionToOperation()` tries `{action}_{resource_type}` first, falls back to `{action}`

### 11. Token Bucket Rate Limiting

**Why**: Allow bursts while enforcing average rate

**Formula**:
- `tokens = min(max, tokens + elapsed * tokensPerMs)`
- Wait if `tokens < 1`

**Better than**: Simple per-request delays (poor UX, doesn't prevent bursts)

### 12. Exponential Backoff Retry

**Why**: Reduces server load during outages

**How**: `backoff_ms: [1000, 2000, 4000]` - each attempt waits longer

**Retries on**: 429 (rate limit), 502/503/504 (server errors)

**Better than**: Linear backoff (thundering herd problem)

### 13. Dual Transport Support (stdio + HTTP)

**Why**: stdio for local development, HTTP for remote/production access

**stdio**: MCP SDK `StdioServerTransport` for local use

**HTTP Streamable** (MCP Spec 2025-03-26):
- POST `/mcp` - client→server messages (JSON-RPC)
- GET `/mcp` - server→client messages (SSE stream)
- DELETE `/mcp` - session termination
- Session management with UUID, 30min timeout default (OAuth sessions: 24h default)
- **OAuth session auto-refresh**: `HttpTransport` stores refresh tokens in `SessionData` and automatically refreshes expired access tokens via `ensureValidSessionToken()` before outbound API calls
- OAuth sessions have extended timeout policy (24h default, configurable) vs static token sessions (30min)
- SSE resumability via `Last-Event-ID`
- Optional heartbeat for reverse proxy keepalive
- Origin validation (DNS rebinding protection)
- CIDR/wildcard support for corporate networks

**Configured via**: `MCP4_TRANSPORT=stdio|http`

## File Structure

```
src/
├── auth/                - OAuth provider and metadata handling
├── core/                - Core runtime (errors, logger, metrics, constants, startup)
├── mcp/                 - MCP server and server manager
├── openapi/             - OpenAPI parsing and operation indexing
├── profile/             - Profile loading, registry, startup profile resolution
├── security/            - Security validators (e.g. SSRF checks)
├── testing/             - Integration utilities and dynamic mock server
├── tool-filter/         - Modular tool filtering architecture
├── tooling/             - Tool generation, composite and DAG executors
├── transport/           - HTTP transport, config, interceptors, client factory
├── types/               - Shared domain and transport types
├── validation/          - JSON-RPC and schema validation utilities
├── generated-schemas.ts - Auto-generated Zod schemas
└── index.ts             - Runtime entrypoint

profiles/
├── gitlab/              - GitLab OpenAPI/profile variants
├── github-security/     - GitHub security alerts profile (code scanning + Dependabot + secret scanning)
├── collabim/            - Collabim profile and converted OpenAPI
├── semgrep/             - Semgrep profile
└── ...                  - Other API profiles

scripts/
├── validate-profile.ts  - Profile validation CLI
├── validate-schema.ts   - Schema meta-validation
└── check-schema-sync.ts - Schema drift verification
```

## Test Coverage

### **Unit Tests**
- OpenAPI parser: spec parsing and parameter resolution
- Profile loader and registry: schema + semantic validation
- Tool generation and composite execution (including DAG executor)
- Transport/interceptors/client factory
- Validation and security utilities
- OAuth provider and metadata handling
- Core services (logger, metrics, constants, startup)

### **Integration Tests**
- HTTP protocol and MCP transport behavior
- End-to-end tool execution across profile-driven mappings

### **E2E Tests**
- HTTP and stdio transports
- Bearer and OAuth authentication flows
- Session lifecycle and streaming behavior

### **Validation and Utility Tests**
- Profile schema validation and CLI validation script
- Testing utilities and mock infrastructure

## Key Test Improvements

### Tool Filter Testing
- **50+ dedicated tests** for filtering module
- ReDoS protection verified with nested quantifier tests
- Unicode normalization tested with composed/decomposed forms
- Category detection tested for simple and composite tools
- Filter precedence (deny > allow) thoroughly tested
- Edge cases: empty configs, all-filtered, no-op detection

## Performance Characteristics

**Startup**:
- OpenAPI parsing: ~500ms for GitLab spec (3600 lines)
- Profile loading: ~20ms
- Index building: O(n) where n = number of operations

**Runtime**:
- Operation lookup: O(1) via Map
- Parameter validation: O(p) where p = number of parameters
- Interceptor overhead: ~2-5ms (auth + rate-limit check)

**Memory**:
- OpenAPI index: ~1MB for GitLab spec
- Negligible for profile config

## Known Limitations

1. **$ref Resolution**: Schema $refs are not fully resolved (parameter refs are handled).
2. **Pagination**: No auto-pagination yet (would require Link-header traversal per API).
3. **Response Validation**: Response bodies are not validated against OpenAPI schemas (requests are validated).
4. **IPv6 CIDR**: Origin validation is primarily focused on IPv4 CIDR ranges.
5. **Composite Execution**: DAG-based dependency execution exists, but automatic dependency inference and full parallel optimization are still limited.

## Production Readiness

### P0 Features (Complete)

**1. Pluggable Logger**
- `Logger` interface with `ConsoleLogger` and `JsonLogger`
- Log levels: DEBUG, INFO, WARN, ERROR, SILENT
- Structured logging with context
- Environment-driven configuration (`MCP4_LOG_LEVEL`, `MCP4_LOG_FORMAT`)
- **Profile-aware token redaction**: Automatically redacts auth credentials (bearer/query/custom-header/session-cookie, including `Cookie`) based on profile configuration

**2. Configuration Over Hard-coding**
- Parameter aliases in profile (no hard-coded `resource_id`, `project_id`)
- Metadata params per tool (not global defaults)
- Array format per API (brackets, indices, repeat, comma)

**3. Partial Results**
- Composite tools support `partial_results: true`
- Returns completed steps + errors even if later steps fail
- `_metadata` includes success status, error details

**4. Schema Validation**
- Request body validated against OpenAPI schema
- Type checking, required fields, enum values, nested objects, arrays
- Format validation (email, URI)
- Clear error messages with JSONPath

### Security Hardening (Complete)

**Prototype Pollution Protection**
- `isSafePropertyName()` blocks dangerous property names (`__proto__`, `constructor`, etc.)
- Applied in: `interceptors.ts`, `composite-executor.ts`, `openapi-parser.ts`

**ReDoS Prevention**
- `escapeRegExp()` escapes special regex characters in user input
- Applied in: `logger.ts` for query parameter redaction

**OAuth Redirect Validation**
- `isAllowedRedirectHost()` validates redirect URIs against `MCP4_ALLOWED_ORIGINS`
- Supports wildcard patterns (`*.example.com`)
- Applied in: `oauth-provider.ts`

**CORS Hardening**
- Origin header validated against allowlist (not reflected)
- Applied in: `http-transport.ts`

**Docker Hardening**
- `read_only: true` - read-only root filesystem
- `no-new-privileges:true` - prevent privilege escalation
- `tmpfs: /tmp:size=64M` - ephemeral writable space

### HTTP Transport (Complete)

**MCP Specification 2025-03-26 Compliant**
- POST/GET/DELETE endpoints
- Session management (UUID, timeout, cleanup)
- SSE streaming with resumability (`Last-Event-ID`)
- Origin validation with CIDR/wildcard support
- Optional heartbeat for reverse proxies
- Health endpoint (`/health`)
- Optional HTML profile index with admin-supplied detail-card descriptions via `MCP4_PROFILES_DESCRIPTION`
- Configurable via environment variables

**Security**:
- DNS rebinding protection
- Localhost-only by default
- CIDR ranges for corporate networks
- Wildcard subdomains (`*.company.com`)
- Session timeout enforcement
- Startup validation for profile-index admin descriptions (JSON shape, duplicate resolution, length limit)

### Prometheus Metrics (Complete)

**Metrics Endpoint** (`/metrics`):
- HTTP requests (total, duration, by method/path/status)
- Sessions (active, created, destroyed)
- Tool calls (total, duration, errors, by tool/status)
- API calls (total, duration, errors, by operation/status)

**Features**:
- Configurable enable/disable (`MCP4_METRICS_ENABLED`)
- Custom metrics path (`MCP4_METRICS_PATH`)
- Path normalization (prevents high cardinality)
- Status grouping (2xx, 4xx, 5xx)
- Prometheus-compatible format

**Integration**:
- Grafana-ready
- Prometheus scrape endpoint
- Production observability

## Future Enhancements

See [TODO.md](./TODO.md) for detailed implementation plans.

**Future Ideas**:
- Auto-pagination (follow `Link` headers)
- Breaking change detection (compare OpenAPI versions)
- Mock server generator from OpenAPI spec
- LLM-based smart routing
- Response validation against schemas
- IPv6 CIDR support for origin validation

## Why This Works

1. **LLM-Friendly**:
   - Clear tool names (`manage_project_badges` not `badge_ops`)
   - Rich descriptions with use-case hints
   - Explicit conditional requirements in descriptions

2. **Fast**:
   - Upfront indexing trades startup time for O(1) lookups
   - Token bucket allows bursts without API violations

3. **Maintainable**:
   - Separation of concerns (parser, loader, generator, executor)
   - Each component independently testable
   - Config-driven (profile changes don't need code deploy)

4. **Flexible**:
   - Works with any OpenAPI 3.x spec
   - Profile system enables unlimited customization
   - Interceptors extensible without touching core logic

5. **Proven Pattern**:
   - Based on youtrack-mcp aggregation approach
   - MCP SDK handles protocol complexity
   - Standard TypeScript tooling (Vitest, Zod, ESLint)

## Schema Synchronization (Critical!)

**Three schema systems must stay in sync:**

1. **TypeScript Types** (`src/types/profile.ts`)
   - IDE support, compile-time type checking
   - Used by all TypeScript code

2. **JSON Schema** (`profile-schema.json`)
   - Profile file validation
   - IDE auto-complete in JSON editors
   - Used by `npm run validate`

3. **Zod Schemas** (`src/generated-schemas.ts`)
   - **Auto-generated runtime validation and parsing**
   - **Generated from TypeScript types via `npm run generate-schemas`**
   - Used during profile loading

**Why Zod can break your features:**
- Zod runs in **strict mode** by default
- Unknown properties are **silently removed** during `parse()`
- Even if TypeScript and JSON Schema are correct, missing Zod field = feature doesn't work

**Debugging checklist:**
1. Profile field works in tests but not runtime? → Run `npm run generate-schemas`
2. TypeScript happy but feature broken? → Run `npm run generate-schemas`
3. JSON validates but field is undefined? → Run `npm run generate-schemas`
