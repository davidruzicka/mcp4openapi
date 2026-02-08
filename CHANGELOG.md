# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added a new GitHub Security profile for code scanning alerts (list/get/instances/update) with dedicated OpenAPI spec and profile test coverage.
- Added missing Collabim profile test definition and aligned optimized Collabim test coverage rules so the profile coverage gate passes.

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
