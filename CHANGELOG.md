# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/davidruzicka/mcp4openapi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/davidruzicka/mcp4openapi/releases/tag/v0.1.0
