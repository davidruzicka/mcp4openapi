# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- REL-01: `UpstreamHeartbeatManager` is now wired into `UpstreamConnectionManager`
- `UpstreamConnectionState` narrowed to `'CONNECTED' | 'FAILED'`; unused `IDLE`/`CONNECTING`/`RECONNECTING` states removed to eliminate misleading contract.
- `UPSTREAM_ERROR_MAPPINGS` moved to module scope in `mcp-server.ts`; was re-allocated on every `tools/call` invocation.
- `mapConnectError` now uses an explicit `hasMcpStatusCode` type guard instead of an unsafe cast, making the SDK status code assumption unit-testable and SDK-upgrade-safe.
- `destroyedSessions` marker is now retained after `closeAll()`
- `tools/list` now emits a `WARN` log when enterprise policy silently blocks all upstream tools (all require `'modify'` permission with no OpenAPI metadata to infer category).
- `validateCredentials` now accepts `sessionId: string | undefined`; pre-session calls log `phase: 'pre-session-init'` instead of the sentinel string `'pre-session'` that polluted log traces. to prevent a race window where a reconnect attempt could create an orphaned upstream connection for a session being torn down.
- `UpstreamConnectionManager` is now statically imported in `mcp-server.ts`; the dynamic import comment claiming a circular dep risk was unverified (confirmed no cycle via madge). - heartbeat pings start on each successful upstream connection and stop on `closeAll`, detecting silent SSE disconnects before tool calls fail.
- `getUpstreamToken` now uses the downstream client token first and falls back to `upstream_mcp[].auth.value_from_env` when the client sends no token; previously env-configured providers always used the env token, ignoring the client-forwarded credential.
- `tools/list` and `tools/call` in upstream proxy mode now enforce `upstream_mcp[].tools.allow`/`deny` lists; previously the profile-level tool policy was validated at load time but never applied at runtime.
- `tools/list` now emits a `WARN` log when `upstream_mcp[].tool_prefix` is configured, as prefixing is accepted by the schema but not yet applied at runtime.
- `getUpstreamMcpConfig` now falls back to `profile.upstream_mcp` when `HttpTransport` profile context does not carry it (single-profile HTTP startup); previously upstream routing was silently bypassed.
- `getOrConnect` now detects token rotation: a changed `token` argument closes the old upstream connection and opens a new one with the fresh credential.
- `closeAll` marks the session as destroyed before awaiting in-flight connections so any `createConnection` resolving after teardown self-closes immediately, preventing orphaned upstream resources.
- `handleToolCall` now enforces `X-Mcp4-Tools` filter and enterprise authorization policy before forwarding to upstream, matching the gates applied to local tools.
- `tools/call` to upstream now validates the tool name against the sanitizer policy (`[a-zA-Z0-9_-]`, max 255 chars) before forwarding, preventing invocation of tools dropped from the sanitized list.
- `UpstreamConnectionManager` now ships with real production `clientFactory`/`transportFactory` defaults (MCP SDK `Client` + `StreamableHTTPClientTransport`); previously both defaults threw, making all upstream proxy calls fail at runtime.
- Profiles with more than one `upstream_mcp` entry are now rejected at load time with a clear error; previously extra providers were silently ignored while all calls were routed to the first.
- `upstream_mcp` proxy is now wired at HTTP startup in both single-profile and profile-routing modes; previously `getUpstreamClientFn` was never set, causing upstream tools to be silently unavailable.
- `drain()` on `NotificationQueue` now re-applies TTL eviction before returning entries, preventing stale notifications from being replayed on reconnect after extended disconnection.
- `upstream_mcp[].validation_endpoint` is now checked during session init in single-profile HTTP mode; previously `upstreamMcp` was missing from `buildDefaultProfileContext`, so init validation was silently skipped.
- `setUpstreamConnectionManager` now registers the `onSessionDestroyed` cleanup listener only once; previously each call added a new listener, causing `closeAll` to be invoked multiple times per session on repeated calls.
- Query-auth upstream providers now have their token appended to the transport URL and validation endpoint URL; previously the token was never sent, causing all query-auth connections to fail authentication.
- Upstream SSE reconnect now replays buffered upstream notifications via `sendToClient()` so they enter the resumability queue and survive a second reconnect.
- `validateCredentials` now throws `UpstreamConnectionError` on non-2xx responses (404, 500, 503, etc.); previously only 401/403 were treated as failures.
- Heartbeat `setInterval` callback now skips a tick when a previous ping is still in-flight, preventing concurrent overlapping pings during upstream slowness.
- `toMcpErrorResponse` omits the `data` field when `correlationId` is absent instead of returning `{ correlationId: undefined }`.
- `validateCredentials` now uses `redirect: 'manual'` to prevent SSRF bypass via HTTP redirects pointing to private/loopback addresses; 3xx responses are treated as failures.
- `closeAll` now calls `client.close()` alongside `transport.close()` to release MCP SDK client resources (handlers, timers).
- Session init no longer logs "Upstream credential validation successful" when no client token is present and validation was a no-op.

### Added
- Upstream MCP proxy: tools/list and tools/call forwarding with tool name/description sanitization, tools/list_changed notification relay with bounded queue buffering and replay on SSE reconnect.
- Upstream tool sanitizer drops tools from upstream MCP servers with invalid names (outside `[a-zA-Z0-9_-]`, over 255 chars) or forbidden description characters (`<`, `>`, backtick, over 2048 chars); dropped names are truncated to 100 chars + ellipsis (103 chars max) to prevent log injection.
- Bounded notification queue buffers upstream MCP notifications with configurable size cap (default 50) and TTL (default 5 min) using wall-clock eviction; drains in insertion order.
- Profile validation now rejects profiles that define both `upstream_mcp` and non-empty `tools[]` with a clear "mutually exclusive" error at load time.
- Upstream MCP session foundation: lazy connection manager, per-session credential store with downstream token passthrough and `value_from_env` fallback, heartbeat health monitoring, typed upstream errors with correlation IDs, and session-scoped connection cleanup.
- Upstream credential validation at session init: optional `validation_endpoint`/`validation_method`/`validation_timeout_ms` fields on `UpstreamMcpServerConfig` enable SSRF-protected early auth checks so invalid tokens surface immediately at session initialization rather than on first tool call.
- Bearer token redaction in error messages now preserves last 4 chars as diagnostic suffix (e.g. `Bearer [REDACTED]...xQ5g`) to help identify which token failed without exposing it.
- Added repository-scoped autonomous-agent docs plus tested proposal-intake/issuer/planner/implementor/reviewer/merger automation helpers, bounded duplicate-candidate ranking/runtime scripts, a default Codex-backed implementor wrapper with machine-readable handoff output, implementor command disclosure reconciliation, and GitHub Actions workflows for the full multi-agent issue-to-PR pipeline.
- Added signed planner-artifact trust primitives plus env-driven verification config so planner review-follow-up handoff can be verified on implementor execution paths while lenient planner dedupe still reads legacy artifacts.
- Added shared review-follow-up/planner-artifact automation primitives for per-head review-thread state, machine-readable fix/test handoff, and implementor in-thread follow-up replies.
- Added profile-driven MCP Apps support with `resources/list`, `resources/templates/list`, `resources/read`, template completion, stricter Apps mapping/path validation, session-aware fetch execution, and bounded fetch-result caching.
- Expanded the GitHub security profile with Secret Scanning CRUD actions, stricter action-gated parameter validation (`allowed_for`/`forbidden_for`), and an upgraded `retrieve_security_overview` composite across code scanning + Dependabot + secret scanning.
- Added enterprise managed authorization for HTTP transport with profile-driven `enterprise_authorization`, JWT bearer grant support on `/oauth/token`, bounded JWKS/replay/token stores, metadata extensions, and security-focused validation/redaction coverage.
- Added env-backed `enterprise_authorization` field resolution for issuer, audience, mode, selected access-policy settings, and claim mappings so deployments can override enterprise auth without editing profiles.
- Added phase 1 support for approved unregistered OAuth clients so authorize requests can materialize local clients when `redirect_uri` matches an explicit allowlist, improving multi-pod OAuth compatibility without weakening redirect validation.

### Changed
- Implementor pipeline now attempts IMPLEMENTOR_FALLBACK_COMMAND on process-level backend failures; @openai/codex moved to devDependencies for cached installs; Codex OAuth auth supported via CODEX_AUTH_JSON with automatic token refresh persistence.
- Refined the autonomous-agent workflow to the final issue/PR label taxonomy, added shared state-machine helpers for issuer/planner/implementor/reviewer transitions, made reviewer/merger automation tolerate legacy review labels during on-touch migration and reconciliation, taught issuer/planner stronger semantic duplicate triage with a pluggable bounded backend contract, and preserved exact open-title duplicate detection as the minimum fallback guard.
- Bumped transitive security-sensitive dependencies via overrides (`@hono/node-server` to `1.19.10`, `hono` to `4.12.4`) and aligned Semgrep SBOM negative test inputs/expectations with current `deploymentSlug`/`deployment_id` validation behavior.
- Updated `express-rate-limit` to `^8.3.1` to remediate the open GitHub Security / Dependabot alert for IPv4-mapped IPv6 rate-limit keying.

### Fixed
- Hardened implementor Codex result handling with a shared JSON-schema validator, stricter prompt contract, regression coverage for malformed or over-permissive machine output (including embedded JSON after brace-like log text), and linked/corrected schema documentation from the README/agent docs.
- Hardened GitHub workflows by disabling persisted checkout credentials across local jobs and replacing the MCP scanner binary fetch with a pinned, SHA256-verified release archive plus regression coverage for workflow hardening.
- Updated the OSV reusable GitHub workflow pin to `google/osv-scanner-action` `v2.3.5` so scheduled scans stop failing on deprecated Node 20 action runtime usage.
- Hardened agent artifact rollout by wiring shipped workflows to pass `MCP4_AGENT_ARTIFACT_*`, rejecting strict trust mode without a signing key, restricting implementor artifact selection to planner-stage comments ordered by creation time, and keeping planner dedupe compatible with legacy unsigned comments while ignoring unverified signed envelopes on unsigned runs.
- Validated env-backed `upstream_mcp_from_env` entries through the Zod schema so malformed JSON (missing fields, wrong types, non-string tools policy) produces typed `ValidationError` instead of opaque `TypeError` at startup; added regression tests for the crash and silent-data-loss paths.
- Preserved proposal-intake duplicate decisions and created-issue ownership across issuer runs so reject-as-duplicate proposals persist metadata, proposal-created issues stay in the planner lane, issuer keeps proposal-intake entry labels idempotent, and proposal-intake no longer recursively re-processes issues it previously created.
- Fixed OSV scan gating for current dev dependencies by overriding transitive `flatted` to `3.4.2`, eliminating the reporter failure caused by known vulnerabilities in `3.3.3`.
- Clarified proposal-intake candidate bounds by wiring `max_candidates` separately from the single-action side-effect budget, keeping legacy env fallbacks, and documenting the one-action-per-run guardrail.
- Blocked dangerous URI schemes during URI validation to prevent XSS through attacker-controlled links and redirects.
- Removed raw environment variable values from selected configuration error messages and added regression checks to prevent secret leakage in errors.
- Hardened MCP Apps resource loading so `file_path` stays inside the profile directory after normalization and symlink resolution, while keeping `resources/read` output shape consistent across inline, file-backed, and fetch-backed resources.
- Fixed HTTP single-profile startup to carry `enterprise_authorization` into transport runtime so enterprise JWT bearer exchange and authenticated initialization work outside profile-routing mode, with dedicated E2E coverage.
- Clarified and locked runtime enterprise authorization behavior so `required` mode enforces trusted enterprise-issued bearer tokens, `optional` mode stays backward-compatible, tool-category policy covers both listing and execution, and invalid env-backed values fail during profile loading.
- Hardened approved unregistered OAuth client materialization by preserving redirect URI unions for shared compatibility `client_id` values (for example VS Code), bounding stored redirect URI payloads to client-store limits, and rejecting insecure `http://`/`https://` scheme-only allowlist rules.

## [0.5.7] - 2026-03-03


### Added
- Restored the dedicated n8n node-list profile (`n8n-nodes`) with its standalone node metadata OpenAPI spec and profile test coverage.

### Changed
- Added `session-cookie` profile auth with managed relogin/cookie rotation and an explicit `allow_shared_with_auth` cache override for authenticated shared responses.
- Updated the `n8n-nodes` profile to use `session-cookie` login for `/types/nodes.json` while keeping explicit public cache enabled for shared node metadata.
- Simplified the README opening flow with a visual "at a glance" overview, a 3-step "how it works" explanation, and a shorter quick-start entry path.

## [0.5.6] - 2026-03-02

### Changed
- Switch Cursor remote snippets to native HTTP config, update docs for token validation and multi-auth with validation examples.

## [0.5.5] - 2026-03-02

### Added
- Added global `MCP4_PARAM_FILTER` / `--param-filter` baseline enforcement for `stdio` and `http`, and extended HTML profile-index filter builders to emit local stdio filter args (`--tool-filter-allow-*`, `--param-filter`) while still using `X-Mcp4-Tools` / `X-Mcp4-Params` for remote HTTP snippets.
- Added tri-state bulk selection toggles to the profile-index tool and parameter filter sections for one-click select-all/clear-all behavior with mixed-state visibility.

### Changed
- Updated Cursor remote HTTP snippets to use native `url` + `headers` + `env` config instead of `mcp-remote`, with sandbox variable references in request headers/query values and `${env:VAR}` only in the `env` copy-through map.

## [0.5.4] - 2026-02-27


## [0.5.3] - 2026-02-25


### Added
- Added `prepare-release-publishing` skill with a tested `patch|minor|major` workflow that inserts dated release headings under `Unreleased`, runs `npm version`, and verifies version consistency against `package.json`.

### Fixed
- Fixed CLI standard flags so `--help`/`-h` prints usage and `--version`/`-v` prints package version without requiring OpenAPI/profile startup configuration.
- Hardened response-cache correctness by honoring request `Cache-Control: no-store`, preserving duplicate query-parameter order in cache keys, and strictly validating `max_memory_bytes_from_env` numeric values.
- Tightened HTTP cache RFC behavior with conditional revalidation (`ETag`/`If-None-Match`, `Last-Modified`/`If-Modified-Since`, `304` merge), request/response `no-cache` and `no-store` safeguards, public-scope `private` and auth protections, `Vary` validation, robust directive parsing, and successful unsafe-method cache invalidation with dedicated tests.
- Fixed HTTP tenant/session token auth flow so interceptor auth no longer requires `value_from_env` when a valid session token is already provided via MCP initialization headers.

## [0.5.1] - 2026-02-24

### Added
- Added profile-configurable in-memory response caching (`interceptors.cache`) with TTL, request deduplication, LRU eviction, and hard `max_memory_bytes` budget limits.

### Fixed
- Fixed HTTP profile index API endpoint/snippet rendering to prefer env-overridden base URLs over profile defaults, so displayed n8n endpoints match effective runtime configuration.

## [0.5.0] - 2026-02-22

### Added
- Added HTTP tenant session override with deterministic exact and `mask:` selectors, startup/runtime collision guards, path-segment wildcards (`*`) for mask URLs, required `profile_ids` tenant scoping, and profile-index tenant metadata with interactive header injection (`X-Mcp4-Tenant-Id`, plus example `X-Mcp4-Api-Base-Url` for `mask:` tenants) including explicit "no tenant" profile-default selection when available.
- Added bundled Codecov OpenAPI profile with CRUD-style aggregated tools (`retrieve_content`, `update_content`), profile aliases, and schema-driven action coverage tests.

### Fixed
- Normalized profile route param handling to accept Express string-array params while preserving `McpRequest.profileId` as `string | undefined`.
- Fixed Vitest v4 regressions in mocked constructor tests and MCP handler lookup tests to keep the suite stable after test-runner upgrades.
- Fixed profile schema sync generation on Node runtimes without `fs.globSync` by falling back to tsconfig-based source discovery.
- Fixed OSV scan gating by pinning direct `ajv` usage to `^8.18.0` and adding a temporary documented ignore for the unresolved `eslint` dev-only transitive `ajv@6.12.6` finding.
- Hardened OAuth in-memory client store limits with configurable env/constructor overrides, idle-grace configuration, active-usage-aware eviction policy, and deterministic 429 responses when no safe eviction candidate exists.
- Fixed proxy-download SSRF policy regression so same-origin URLs remain allowed when `allowed_hosts` is configured for cross-origin `skip_auth` flows, while still enforcing private-network SSRF checks.

### Changed
- Refreshed lockfile with latest non-breaking dependency updates available under current semver ranges.
- Upgraded the dev test/lint toolchain to eslint 10 and Vitest 4, replaced `typescript-json-schema` with `ts-json-schema-generator`, and updated schema-sync generation scripts accordingly.
- Updated Vitest configuration to v4 worker options (`maxWorkers`, `isolate`, `fileParallelism`) to remove deprecated `poolOptions` usage.
- Extended local stdio profile-index snippets for Claude Code CLI and Gemini (JSON + CLI) to include API base URL env wiring, and enabled tenant API-base override injection for Gemini local JSON snippets.
- Added `profile_id` and `tenant_id` labels to HTTP/session/tool/API Prometheus metrics with explicit fallbacks (`unknown`/`none`) to support tenant-aware observability.

## [0.4.0] - 2026-02-16

### Added
- Added profile-defined MCP prompt support (`prompts/list`, `prompts/get`) with prompt schema types, runtime rendering, and HTTP/SDK test coverage.
- Added DefectDojo read-only profile and smoke test profile for healthcheck, token reports, and metrics endpoints.
- Added Gemini CLI snippets to HTTP profile index for remote streamable HTTP and local stdio configuration (JSON + CLI).

### Changed
- Generic profile test runner now resolves OpenAPI spec from profile `openapi_spec_path` first and only falls back to `openapi.*` convention.
- HTML profile index now shows more specific set of configurations for each profile.
- HTTP initialize auth gate now preserves `value_from_env` server-token fallback while still rejecting unauthenticated init when no fallback token is available.

## [0.3.9] - 2026-02-10

### Fixed
- Fixed some Collabim optimized profile filter parameter types to use boolean values instead of numeric enums.

## [0.3.8] - 2026-02-10

### Changed
- Hardened HttpClient security with SSRF validation across redirect hops, configurable request timeout (timeout_ms, default 30s), and cross-origin auth-header stripping.

## [0.3.7] - 2026-02-08

### Added
- Added a new GitHub Security profile for code scanning alerts (list/get/instances/update) with dedicated OpenAPI spec and profile test coverage.
- Added missing Collabim profile test definition and aligned optimized Collabim test coverage rules so the profile coverage gate passes.

### Changed
- Hardened auth token validation endpoint handling: absolute URLs now require base-origin match or explicit `validation_allowed_hosts`, with SSRF host allowlist enforcement.

## [0.3.6] - 2026-02-08

### Changed
- Use COLLABIM_TOKEN as auth environment variable in profile configuration.

## [0.3.5] - 2026-02-08

### Added
- Added Collabim API Blueprint assets with generated OpenAPI spec plus a CRUD-oriented optimized profile and profile tests.

### Changed
- Refactored SSRF IP range checks to use CIDR matching via ipaddr.js.
- Updated @modelcontextprotocol/sdk to 1.26.0 (security fix).
- Defaulted generated string schemas to a 4096 maxLength when pattern is set without maxLength to reduce ReDoS risk.
- Hardened OAuth/bootstrap security
- Changed OAuth default limits to 10 requests per 1 minute while keeping OAuth state timeout at 10 minutes.
- Added nightly and manual MCP security scanning workflow with SARIF upload to GitHub Security tab.
- Automated profile schema synchronization from TypeScript types with drift-check tooling for Zod and JSON schema outputs.

## [0.3.4] - 2026-02-05

### Fixed
- Versions sync

## [0.3.3] - 2026-02-05

### Added
- Added HTTP profile routing allowlist controls (`MCP4_ALLOW_PROFILES`, `MCP4_ALLOW_PROFILES_REGEX`) for allowed profile ids/names/aliases with optional regex matching.
- GitLab profiles now expose common list filters for projects, issues, merge requests, and issue notes (including owned and membership for projects).

### Changes
- Docker image now bundles profiles and HTML assets.

### Fixed
- GitLab GLQL request schema now uses glql_yaml to match API requirements.

## [0.3.2] - 2026-02-03

### Added
- Added GitLab CRUD-oriented profile.
- Added Grafana OpenAPI spec and CRUD-oriented Grafana profile.
- Added Mattermost OpenAPI spec and CRUD MCP profile covering users, teams, channels, posts, files, reactions, and threads.

### Changed
- Enhance GitLab OpenAPI/profiles with new issue and MR functionalities.
- Standardized CRUD-oriented n8n-optimized profile.

## [0.3.1] - 2026-02-03

### Added
- Added optional HTTP profile index page for routed profiles, including connection snippets and auth-aware guidance.

### Changed
- Updated bundled profile descriptions to clarify access-style vs operation-style tools and show concrete API-to-tool reduction counts.

## [0.3.0] - 2026-01-31

### Added
- Metrics collection for external API calls and errors.
- Validation for base64 input in tool generator.
- Profile routing with trust proxy support, plus profile-scoped OAuth metadata and protected-resource endpoints (including RFC 8414 path-suffix routes).
- n8n OpenAPI specification and MCP profiles, plus node list metadata API and workflow management updates.
- Support for custom authentication headers based on profile configuration.
- Support for root array request bodies and quoted field names in MCPServer.
- Bundled profiles in the npm package and CLI listing via `--list-profiles`/`-l`.
- Missing defense-in-depth security headers.

### Changed
- Refactor: group src files by domain folders.
- Update GitLab profile and API to support pagination and default parameter values.
- Prioritize header tokens over session tokens.
- Update hono dependency to 4.11.7.
- Profile resolution now falls back to bundled profiles when `./profiles` is missing.
- docs: update PROFILE-GUIDE.md to clarify required inputs for MCP tool profiles.
- docs: update AGENTS.md to replace multi-auth section with profile testing strategies.
- docs: add finding regarding OAuth pre-registered client for VS Code and clarify false positive handling.
- docs: update README to include MCP architecture diagram and improve profile descriptions.
- docs: add CLAUDE.md and GEMINI.md files referencing @AGENTS.md.

### Fixed
- ConsoleLogger sanitization to prevent log injection (strip ANSI escape codes and escape control characters).
- Path segments encoding.
- Preserve profile-scoped OAuth metadata from resource URL.

## [0.2.8] - 2025-12-20

### Added
- YouTrack profile support for project custom fields, including new actions and response field selection for project custom field details.

### Changed
- HTTP transport now uses typed errors and correlation IDs for client-facing responses, with stricter token/header validation.
- Proxy downloads validate URL schemes/origins, enforce redirect limits, and add allowlist/private-network controls.

## [0.2.7] - 2025-12-18

### Changed
- Stabilized GitLab E2E suites by reusing a single mock server and MCP process per file, reducing startup/shutdown overhead.
- Hardened HTTP transport config tests by mocking `HttpTransport` construction, ensuring environment-derived settings are exercised.

## [0.2.6] - 2025-12-17

### Added
- GitLab OpenAPI/profile coverage for merge-request discussions, approvals, snippet downloads, and job artifact proxy downloads so developers can fetch diffs/attachments even when GitLab is private.
- Improved GitLab E2E suite covering pipelines/jobs, snippet proxy downloads, and merge-request workflows to guard against regressions in high-risk flows.

## [0.2.5] - 2025-12-15

### Added
- Optimized YouTrack profile with parameter aliases and `proxy_download` operations for attachment retrieval (bearer auth and size guardrails).
- `ProxyDownloadExecutor` that fetches metadata, validates MIME type/size, and returns base64 content with optional auth bypass on final download.
- Bundled YouTrack assets (full OpenAPI spec plus optimized and minimal profiles) wired for env-based base URL/token injection, curated response fields, and attachment download coverage in integration/E2E tests.

### Changed
- Query parameter aliasing now works for YouTrack search operations, aligning OpenAPI names with profile-friendly parameters and extending coverage in parameter-mapping tests.
- YouTrack issue responses keep curated fields plus attachments/comments to ensure proxy downloads have the required context.
- Removed the default YouTrack base URL so deployments must provide an explicit environment-driven base URL (tests use a mock server by default).

## [0.2.4] - 2025-12-04

### Added
- Automated publishing to npmjs.org and GitHub Packages on tag
- Release process documentation (docs/RELEASING.md)
- End-to-end (E2E) test job in CI workflow
- Multi-auth configuration with priority-based fallback in PROFILE-GUIDE.md
- OAuth rate limiting configuration in PROFILE-GUIDE.md
- Token validation configuration (validation_endpoint) in PROFILE-GUIDE.md

### Changed
- CI workflow now requires all tests (unit + e2e) to pass before publishing
- Improved test coverage for `validation-utils.ts` and `oauth-provider.ts`
- Docker images are now built for both amd64 and arm64 architectures
- Updated documentation to clarify validation_endpoint is relative to base URL

### Fixed
- DNS rebinding protection and minor security fixes
- Profile validation fixes
- TypeScript error in oauth-provider.test.ts (clientsStore possibly undefined)
- Documentation and comments for OIDC and publishing steps
- Fixed broken DEPLOYMENT-K8S-OAUTH.md reference in README

## [0.2.3] - 2025-12-01

### Added
- Support for HTTP/HTTPS URLs in `MCP4_OPENAPI_SPEC_PATH`

### Changed
- Improved test coverage

### Fixed
- Minor security fixes

## [0.2.2] - 2025-11-30

### Added
- Security hardening: prototype pollution protection via `isSafePropertyName()`
- Security hardening: ReDoS prevention via `escapeRegExp()`
- Security hardening: OAuth redirect URI validation against `MCP4_ALLOWED_ORIGINS`
- Security hardening: CORS origin validation (no longer reflects user input)
- Docker hardening: `read_only`, `no-new-privileges`, `tmpfs` options

### Changed
- Refactored `ConsoleLogger` and `JsonLogger` to use shared redaction utilities from `validation-utils.ts`

## [0.2.1] - 2025-11-29

### Added
- Codecov integration with coverage badge
- CI workflow with test analytics (JUnit XML reporter)

## [0.2.0] - 2025-11-28

### Added
- HTTP Streamable transport (MCP Specification 2025-03-26)
- OAuth 2.0 authentication with PKCE flow
- Multi-auth support (OAuth + Bearer fallback)
- Prometheus metrics endpoint (`/metrics`)
- Session management with SSE resumability
- Rate limiting for HTTP and OAuth endpoints
- DAG-based parallel execution for composite tools
- Profile-aware token redaction in logs

### Changed
- Migrated from `/sse` to `/mcp` endpoint (legacy alias maintained)

## [0.1.0] - 2025-11-15

### Added
- Initial release
- OpenAPI 3.x specification support
- Profile-based tool aggregation
- Composite tools for multi-step workflows
- Bearer, custom-header, and query authentication
- Rate limiting with token bucket algorithm
- Exponential backoff retry logic
- Schema validation for request bodies
- Structured logging (console/JSON)

[Unreleased]: https://github.com/davidruzicka/mcp4openapi/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.8...v0.3.0
[0.2.8]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/davidruzicka/mcp4openapi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/davidruzicka/mcp4openapi/releases/tag/v0.1.0
