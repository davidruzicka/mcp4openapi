# External Integrations

## OpenAPI Spec Sources

| Source | How | Config |
|--------|-----|--------|
| Local file | fs.readFile | `MCP4_OPENAPI_SPEC_PATH` or `openapi_spec_path` in profile |
| Remote HTTP | fetch | Same env/profile field, accepts HTTPS URL |
| YAML or JSON | auto-detected | `yaml` + `swagger-parser` for $ref resolution |

## Downstream APIs (via Profiles)

mcp4openapi is a generic proxy - it connects to whatever API the loaded profile targets. Bundled profiles:

| Profile | API | Auth |
|---------|-----|------|
| `profiles/youtrack/` | JetBrains YouTrack | Bearer token |
| `profiles/gitlab/` | GitLab | Bearer / OAuth |
| `profiles/github-security/` | GitHub Security APIs | Bearer token |
| `profiles/grafana/` | Grafana | Bearer token |
| `profiles/n8n/` | n8n automation | Session cookie |
| `profiles/mattermost/` | Mattermost | Bearer token |
| `profiles/semgrep/` | Semgrep SAST | Bearer token |
| `profiles/collabim/` | Collabim | Bearer token |
| `profiles/seznam/` | Seznam.cz APIs | Bearer token |
| `profiles/codecov/` | Codecov | Bearer token |

## Authentication Providers

### Interceptor Chain Auth Types (`src/transport/interceptors.ts`)
- `bearer` - `Authorization: Bearer <token>` header
- `query` - token as query parameter (e.g., `?api_token=`)
- `custom-header` - arbitrary header name + token
- `session-cookie` - cookie-based auth with session management

### OAuth 2.0 (`src/auth/oauth-provider.ts`)
- RFC 7636 PKCE flow (code challenge/verifier)
- RFC 7591 dynamic client registration
- Discovery via `.well-known/oauth-authorization-server`
- Supported providers: GitLab, GitHub, any RFC-compliant OAuth server

### Enterprise Auth (`src/auth/enterprise-auth-provider.ts`)
- JWKS-based JWT validation
- Managed authorization with claim extraction
- Multi-tenant support via `src/http-tenants.ts`

## MCP SDK Integration

- `@modelcontextprotocol/sdk` 1.26.0
- Stdio transport: `StdioServerTransport`
- HTTP transport: custom implementation (MCP spec 2025-03-26)
  - POST/GET/DELETE endpoints, SSE, session management
  - `src/transport/http-transport.ts` (Hono-based)

## Observability

| Integration | Package | Where |
|-------------|---------|-------|
| Prometheus metrics | `prom-client` | `src/core/index.ts`, exposed on `/metrics` |
| Structured logging | custom (token-redacting) | `src/core/` |
| GitHub Actions CI | `.github/workflows/` | Push/PR triggers |
| Implementor pipeline | `.github/workflows/implementor.yml` | Issue → PR automation via Codex |

## GitHub Automation (`src/automation/`)

The implementor pipeline integrates with:
- **GitHub API** (via `@octokit/rest`) - issue read, PR create/update, labels
- **OpenAI Codex** (`@openai/codex`) - autonomous code generation agent
- **GH_PAT_FOR_SECRETS** - GitHub PAT for writing workflow secrets
- `CODEX_AUTH_JSON` or `OPENAI_API_KEY` - Codex authentication

## Rate Limiting

- `express-rate-limit` applied on HTTP transport endpoints
- Profile-configurable interceptor: `interceptors.rate_limit` in profile JSON

## SSRF Protection

- `ipaddr.js` for IP range / CIDR block validation
- `src/security/ssrf-validator.ts` - blocks private/loopback/reserved ranges
- Applied to: OAuth discovery fetches, OpenAPI spec HTTP loads, proxy requests
