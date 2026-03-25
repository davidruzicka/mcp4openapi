# Architecture

**Analysis Date:** 2026-03-25

## Pattern Overview

**Overall:** Layered MCP Server with Configuration-Driven Tool Generation

The system follows a **strict separation of concerns** architecture with four primary layers:
1. **Transport Layer** - HTTP/stdio handling
2. **Core Processing Layer** - OpenAPI parsing, profile loading, tool generation
3. **Execution Layer** - Request execution with interceptor chain
4. **Tool Filtering Layer** - Modular filtering with strategy pattern

**Key Characteristics:**
- Configuration-driven (no hard-coded API assumptions)
- Schema-based validation (Zod at runtime, JSON Schema for IDE support)
- Interceptor chain pattern for cross-cutting concerns
- Modular tool filtering with pluggable rules
- Profile-based multi-tenancy and server routing

## Layers

**CLI & Bootstrap (Entry Point):**
- Purpose: Parse environment variables, initialize logger, resolve profile/OpenAPI spec
- Location: `src/core/index.ts`, `src/index.ts`
- Contains: CLI argument parsing, profile discovery, server initialization
- Depends on: Profile registry, logger, HTTP transport config
- Used by: Package.json bin entry (`mcp4openapi`)

**MCP Server Coordination:**
- Purpose: Single entry point for tool registration, invocation, resource serving, prompt rendering
- Location: `src/mcp/mcp-server.ts`
- Contains: Tool registration, request routing (initialize, callTool, listTools, etc.)
- Depends on: OpenAPI parser, profile loader, tool generator, composite executor, HTTP client factory
- Used by: Transport layers (stdio, HTTP)

**OpenAPI Parsing & Indexing:**
- Purpose: Load OpenAPI specs (file or URL), index operations by operationId and path for O(1) lookup
- Location: `src/openapi/openapi-parser.ts`
- Contains: YAML/JSON parsing, $ref resolution for parameters, operation indexing, schema caching
- Depends on: SSRF validator (security), fs/fetch
- Used by: Profile loader, tool generator, composite executor

**Profile Loading & Validation:**
- Purpose: Parse profile JSON, validate against auto-generated Zod schemas, resolve semantic rules
- Location: `src/profile/profile-loader.ts`
- Contains: Profile schema validation, operation verification, tool name normalization, enterprise auth validation
- Depends on: OpenAPI parser, generated Zod schemas, tool filter utils
- Used by: MCP server, profile registry

**Tool Generation:**
- Purpose: Convert profile tool definitions into MCP SDK tool objects with JSON Schema parameters
- Location: `src/tooling/tool-generator.ts`
- Contains: MCP tool construction, JSON schema generation from parameter definitions, conditional requirement hints
- Depends on: Profile definitions, regex validator
- Used by: MCP server

**HTTP Client & Interceptor Chain:**
- Purpose: Execute API requests with auth, rate-limiting, retry, caching middleware
- Location: `src/transport/interceptors.ts`, `src/transport/http-client-factory.ts`
- Contains: Interceptor chain builder, auth interceptor, rate-limit, retry, response cache
- Depends on: Auth runtime provider, cache policies, metrics collector
- Used by: Composite executor, MCP server for direct tool execution

**Tool Filtering:**
- Purpose: Modular filtering to restrict tool access based on environment variables or HTTP headers
- Location: `src/tool-filter/` (15+ modules)
- Contains: Regex validation, operation classification, filter engine, global/session filtering
- Depends on: Tool definitions, operation resolver
- Used by: MCP server during listTools

**Composite Executor:**
- Purpose: Chain multiple API calls with dependency resolution, aggregate results into nested structure
- Location: `src/tooling/composite-executor.ts`, `src/tooling/dag-executor.ts`
- Contains: DAG topological sort, parallel level execution, result aggregation, error handling
- Depends on: OpenAPI parser, HTTP client, parameter aliases
- Used by: MCP server for composite tools

**Request Validation & Normalization:**
- Purpose: Validate parameters against schema, normalize array/object formats, apply defaults
- Location: `src/validation/` (argument-normalizer, schema-validator, validation-utils)
- Contains: Parameter type coercion, array serialization handling, conditional requirement enforcement
- Depends on: Tool definitions, OpenAPI schemas
- Used by: MCP server before execution

**HTTP Transport (Optional):**
- Purpose: HTTP server wrapper around MCP with OAuth, multi-profile routing, security enforcement
- Location: `src/transport/http-transport.ts`, `src/transport/http-client-factory.ts`
- Contains: Express middleware, session management, OAuth flow, CORS, rate limits
- Depends on: MCP server instances, profile registry, authentication providers
- Used by: CLI when `MCP4_TRANSPORT=http`

## Data Flow

**Startup Flow:**

1. CLI reads environment: profile ID, OpenAPI spec path, auth token, HTTP config
2. Profile registry resolves profile from directory (by id, name, or alias)
3. ProfileLoader validates profile JSON against Zod schemas
4. OpenAPIParser loads and indexes OpenAPI spec
5. ProfileLoader verifies operations exist in OpenAPI spec
6. ToolGenerator converts profile tools into MCP tool definitions
7. ToolFilterService initialized with global env var filters
8. MCPServer ready, awaits requests

**Tool Call Flow:**

1. MCP callTool request arrives with tool name and arguments
2. ToolDefinition resolved from profile
3. Arguments normalized (array formats, object entries)
4. Arguments validated against JSON schema + conditional requirements
5. Operation(s) resolved from OpenAPI spec
6. If composite tool: DAGExecutor analyzes dependencies
7. HTTPClient executes with interceptor chain:
   - Auth interceptor: adds credentials
   - Cache interceptor: checks cache, stores response
   - Rate-limit interceptor: enforces token bucket
   - Retry interceptor: exponential backoff on failure
   - Fetch: actual HTTP request
8. Response validated, returned to caller

**State Management:**

- **Profile State:** Immutable, loaded once at startup
- **Operation Index:** In-memory Map (OpenAPIParser.index)
- **Schema Cache:** In-memory Map per parser instance
- **HTTP Session State:** Per-interceptor-chain (login cookies, auth tokens)
- **Tool Filter State:** Computed at startup + per-session (HTTP headers)
- **Request Context:** Local to callTool handler (correlation IDs, metrics)

## Key Abstractions

**Profile Definition:**
- Purpose: JSON structure defining tools, operations, parameters, auth, cache, rate-limit config
- Examples: `src/types/profile.ts`, `profiles/gitlab/profile.json`
- Pattern: All API customization captured in configuration, no code changes needed

**Tool Definition:**
- Purpose: Single or composite operation mapping
- Examples: `name`, `description`, `simple_operations`, `composite_steps`
- Pattern: Profile declares operations, tool generator creates MCP SDK tools

**Parameter Definition:**
- Purpose: Parameter schema with type, required conditions, defaults, validation
- Examples: `required`, `required_for`, `allowed_for`, `forbidden_for`, `enum_for`
- Pattern: Conditional logic data-driven via fields, not imperative if/else

**Interceptor Chain:**
- Purpose: Middleware-style request/response processing
- Order: auth -> cache -> rate-limit -> retry -> fetch
- Pattern: Each interceptor independently testable, composed at runtime

**Operation Resolver:**
- Purpose: Interface for looking up operations, classifying by category (list/read/modify)
- Examples: `OpenAPIOperationResolver`, used by `OperationDetector` for filtering
- Pattern: Abstract interface enables testing without real OpenAPI spec

**Filter Rules:**
- Purpose: Strategy pattern for tool matching (Exact, Regex, Category)
- Examples: `ExactMatchRule`, `RegexMatchRule`, `CategoryMatchRule`
- Pattern: Data-driven (rule config) enabling composition and testing

## Entry Points

**CLI Entry (stdio mode):**
- Location: `src/index.ts`
- Triggers: `mcp4openapi` command invoked by Claude Desktop or MCP client
- Responsibilities: Load env, initialize MCPServer with stdio transport, handle JSONRPC requests

**CLI Entry (HTTP mode):**
- Location: `src/core/index.ts` (main function)
- Triggers: `mcp4openapi` command with `MCP4_TRANSPORT=http`
- Responsibilities: Initialize Express app, set up HTTP middleware, handle OAuth, route profiles

**Profile Registry Entry:**
- Location: `src/profile/profile-registry.ts`
- Triggers: Profile lookup by `--profile` flag or `MCP4_PROFILE` env
- Responsibilities: Discover profiles in directory, resolve by id/name/alias, validate existence

**HTTP Profile Routing:**
- Location: `src/transport/http-transport.ts`
- Triggers: Request to `/profile/:profileId/mcp`
- Responsibilities: Route to profile-specific MCPServer instance, lazy initialize servers, cache

## Error Handling

**Strategy:** Typed error hierarchy with machine-readable codes and correlation IDs

**Patterns:**

- **ValidationError**: Malformed input (profile, parameters, schema)
  - Used in: ProfileLoader, SchemaValidator, ToolGenerator
  - Contains: Field path, expected/actual values
  - Example: `src/core/errors.ts` - field-level validation with details

- **OperationNotFoundError**: Operation ID missing from OpenAPI spec
  - Used in: Tool execution, composite executor
  - Contains: Operation ID
  - Example: Attempt to execute tool mapping to non-existent operation

- **AuthenticationError**: Missing or invalid auth token
  - Used in: Auth interceptor
  - Contains: Auth type (bearer/query/header)
  - Example: Bearer token expired or missing

- **RateLimitError**: Rate limit exceeded
  - Used in: Rate-limit interceptor
  - Contains: Retry-After seconds
  - Example: Token bucket depleted for endpoint

- **NetworkError**: HTTP connection failure
  - Used in: Retry interceptor after max attempts
  - Contains: URL, status, error message
  - Example: Timeout, connection refused

- **ConfigurationError**: Invalid profile, spec path, or runtime config
  - Used in: Startup validation
  - Contains: Field name, expected format
  - Example: Missing required interceptor field

All errors include correlation ID (`generateCorrelationId()`) for debugging across logs.

## Cross-Cutting Concerns

**Logging:**
- Implementation: `src/core/logger.ts` (ConsoleLogger, JsonLogger)
- Pattern: Injected into services, structured logging with log levels
- Token redaction: Automatic based on profile auth type (bearer/query/header/session-cookie)

**Validation:**
- Implementation: Zod (runtime), JSON Schema (IDE support)
- Pattern: Early validation at profile load time, argument validation pre-execution
- Files: `src/generated-schemas.ts` (auto-generated from TypeScript types)

**Authentication:**
- Implementation: Interceptor chain + auth runtime provider
- Pattern: Pluggable auth strategies (bearer, query param, custom header, session cookie)
- Files: `src/transport/interceptors.ts`, `src/transport/auth-runtime.ts`

**Metrics & Observability:**
- Implementation: `src/core/metrics.ts` (MetricsCollector)
- Pattern: Labeled metrics (profileId, tenantId, operation, category)
- Tracked: Request count, duration, cache hits/misses, errors, rate limit

**SSRF Protection:**
- Implementation: `src/security/ssrf-validator.ts`
- Pattern: Validate URLs at bootstrap time (OpenAPI spec loading, OAuth metadata)
- Files: Used in OpenAPIParser and main() before TLS connections

---

*Architecture analysis: 2026-03-25*
