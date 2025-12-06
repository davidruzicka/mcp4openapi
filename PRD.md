# PRD: mcp4openapi (Universal OpenAPI to MCP Server)

## 1. Product overview

### 1.1 Document title and version

- **Title:** PRD: mcp4openapi (Universal OpenAPI to MCP Server)
- **Version:** 1.0

### 1.2 Product summary

`mcp4openapi` is a universal Model Context Protocol (MCP) server that automatically generates MCP tools from any valid OpenAPI 3.x specification. It allows Large Language Models (LLMs) like Claude or Copilot to interact with external REST APIs without writing any custom integration code.

The product prioritizes a "Zero Config" experience where users simply provide an OpenAPI URL to get started. For advanced use cases, it supports a "Profile" system that allows developers to curate, filter, and aggregate API operations into optimized tools, reducing context pollution and improving LLM reliability.

## 2. Goals

### 2.1 Business goals

- **Accelerate Integration:** Enable rapid connection of any OpenAPI-compliant service to the MCP ecosystem without custom development.
- **Improve LLM Efficiency:** Reduce token usage and context window pollution by allowing granular control over exposed tools and response fields via Profiles.
- **Enterprise Readiness:** Support robust authentication (OAuth 2.0, Bearer), observability (metrics, logging), and secure transport options.

### 2.2 User goals

- **LLM User:** Instantly access API tools by just pointing to a spec URL ("It just works").
- **Developer/Integrator:** Customize tool definitions, hide dangerous operations, and chain multiple API calls into single logical actions to simplify complex workflows.

### 2.3 Non-goals

- **Legacy Support:** Support for OpenAPI 2.0 (Swagger) is not a priority for v1.0.
- **Protocol Translation:** We do not aim to support non-REST protocols (GraphQL, gRPC) in this specific server.

## 3. User personas

### 3.1 Key user types

- **The Consumer (LLM User)**
- **The Integrator (Developer/DevOps)**

### 3.2 Basic persona details

- **The Consumer**: Uses LLM clients (Claude Desktop, VS Code Copilot) and wants to connect to a service (e.g., GitLab, Jira) quickly. They care about ease of setup and tool reliability.
- **The Integrator**: Configures the MCP server for a team or specific use case. They care about security (hiding admin endpoints), performance (filtering huge JSON responses), and usability (renaming cryptic API operation IDs).

### 3.3 Role-based access

- **Admin**: Full access to server configuration (env vars, profiles).
- **User**: Consumes the exposed tools via the MCP client.

## 4. Functional requirements

### 4.1 Core Functionality (Priority: P0)

- **OpenAPI Parsing**:
  - Must load OpenAPI 3.x specifications from a local file path.
  - Must load OpenAPI 3.x specifications from a public HTTP/HTTPS URL.
  - Must validate the specification and handle parsing errors gracefully.
- **Tool Generation**:
  - Automatically generate MCP tools for all `GET`, `POST`, `PUT`, `PATCH`, `DELETE` operations defined in the spec.
  - Use `operationId` (or fallback to path+method) for tool naming.
  - Map OpenAPI parameters (path, query, body) to MCP tool arguments.

### 4.2 Profile System (Priority: P1)

- **Tool Filtering**: Allow allowlisting specific operations to expose (e.g., only read-only endpoints).
- **Aliasing**: Rename complex `operationId`s to human-readable tool names (e.g., `get_project_issues_v4` -> `list_issues`).
- **Response Filtering**: Define JSON paths to keep in the API response, discarding irrelevant data to save context.
- **Composite Tools**:
  - Chain multiple API calls into a single MCP tool (e.g., "Create Project" + "Add Badge").
  - Support passing outputs from one step as inputs to the next.
- **Metadata Parameters**: Inject static parameters (like `user_agent` or `api_version`) that are hidden from the LLM.

### 4.3 Authentication (Priority: P0)

- **Token-based Auth**:
  - Support `Authorization: Bearer <token>`.
  - Support custom headers (e.g., `X-API-Key`).
  - Support query parameters (e.g., `?api_key=...`).
  - Read tokens securely from environment variables.
- **OAuth 2.0**:
  - Support Authorization Code flow for HTTP transport.
  - Handle token refresh automatically.
- **Multi-Auth**: Support fallback strategies (try OAuth, then Bearer).

### 4.4 Transport & Security (Priority: P1)

- **Stdio Transport**: Default mode for local CLI usage.
- **HTTP Transport**: Server-Sent Events (SSE) support for remote deployment.
- **Security**:
  - Redact sensitive tokens from logs.
  - Enforce DNS rebinding protection for local HTTP servers.

## 5. User experience

### 5.1 Entry points & first-time user flow

- **CLI (npx)**: User runs `npx mcp4openapi` with env vars. No install needed.
- **Docker**: User runs a pre-built Docker container.

### 5.2 Core experience

- **Zero Config**:
  1. User sets `MCP4_OPENAPI_SPEC_PATH` to a URL.
  2. User sets `MCP4_API_TOKEN`.
  3. Server starts and exposes all valid operations as tools.

- **Profile Config**:
  1. User creates a `profile.json`.
  2. User maps `operationId`s to friendly names.
  3. User defines composite workflows.
  4. Server starts with `MCP4_PROFILE_PATH`, exposing only the curated tools.

### 5.3 Advanced features & edge cases

- **Composite Workflows**: Handling partial failures in a chain (e.g., step 1 succeeds, step 2 fails).
- **Large Specs**: Indexing large specs (like GitLab/AWS) to ensure fast tool lookups.

## 6. Narrative

A developer wants to let Claude manage their GitLab issues. They run `mcp4openapi` pointing to GitLab's OpenAPI URL. Initially, Claude is overwhelmed by 500+ tools. The developer creates a simple `profile.json` selecting only "retrieve_content" and "set_content" related operations with defined targets as "issue", "project", "merge_request" etc. Now, Claude sees a clean, focused toolset and can perform complex tasks like "Find high priority bugs and assign them to me" efficiently.

## 7. Success metrics

### 7.1 User-centric metrics

- **Time to First Tool Call**: < 5 minutes from installation.
- **Context Efficiency**: % reduction in token usage when using Profiles vs. raw API.

### 7.2 Business metrics

- **Adoption**: Number of GitHub stars/forks.
- **Ecosystem**: Number of community-contributed Profiles.

### 7.3 Technical metrics

- **Startup Time**: < 2 seconds for average specs.
- **Error Rate**: < 1% for valid API calls.

## 8. Technical considerations

### 8.1 Integration points

- **MCP SDK**: Built on top of the official TypeScript MCP SDK.
- **OpenAPI Parser**: Uses standard libraries to parse YAML/JSON specs.

### 8.2 Data storage & privacy

- **Stateless**: The server is stateless (except for OAuth sessions in memory).
- **No Persistence**: No user data is stored on disk.

### 8.3 Scalability & performance

- **Indexing**: Pre-index OpenAPI operations on startup to avoid O(n) lookups during execution.
- **Streaming**: Use SSE for HTTP transport to handle long-running LLM interactions.

### 8.4 Potential challenges

- **Malformed Specs**: Many public OpenAPI specs are invalid or incomplete. We need robust error handling.
- **Auth Complexity**: OAuth flows vary significantly between providers.

## 9. Milestones & sequencing

### 9.1 Project estimate

- **Size**: Medium (Existing codebase is ~3k LOC).

### 9.2 Team size & composition

- **1 Backend Engineer**: Core logic, OpenAPI parsing.

### 9.3 Suggested phases

- **Phase 1: Core Stability (Current)**: Robust parsing, Stdio transport, Basic Auth.
- **Phase 2: Advanced Profiles**: Composite tools, deep response filtering.
- **Phase 3: Remote & OAuth**: HTTP transport, OAuth 2.0, Dockerization.
- **Phase 4: Future (v2.0)**: Runtime spec loading, UI for profile generation, Multi-tenant support.

## 10. User stories

### 10.1. Zero Config Startup

- **ID**: GH-001
- **Description**: As a user, I want to start the server with just an OpenAPI URL and an API token so that I can use the tools immediately without configuration.
- **Acceptance criteria**:
  - Server accepts `MCP4_OPENAPI_SPEC_PATH` as a URL.
  - Server accepts `MCP4_API_TOKEN` for Bearer auth.
  - All valid operations in the spec are exposed as tools.

### 10.2. Profile-based Tool Filtering

- **ID**: GH-002
- **Description**: As an integrator, I want to use a profile to allowlist specific API operations so that the LLM is not confused by irrelevant or dangerous tools.
- **Acceptance criteria**:
  - Server accepts `MCP4_PROFILE_PATH`.
  - Only tools defined in the profile are exposed.
  - Tools can be renamed via the profile.

### 10.3. Composite Tools

- **ID**: GH-003
- **Description**: As an integrator, I want to chain multiple API calls into a single tool so that the LLM can perform complex actions (like "create project and add webhook") in one step.
- **Acceptance criteria**:
  - Profile supports `composite: true` tool definitions.
  - Steps are executed in order.
  - Output from step N can be used in step N+1.

### 10.4. OAuth Authentication

- **ID**: GH-004
- **Description**: As a user, I want to authenticate via OAuth 2.0 so that I don't have to manually manage long-lived tokens.
- **Acceptance criteria**:
  - HTTP transport supports OAuth authorization code flow.
  - Server handles token exchange and refresh.
  - Access token is automatically injected into API requests.
