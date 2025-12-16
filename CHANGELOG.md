# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.5...HEAD
[0.2.4]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/davidruzicka/mcp4openapi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/davidruzicka/mcp4openapi/releases/tag/v0.1.0
