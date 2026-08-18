# HTTP Transport Guide

HTTP Streamable transport enables remote MCP server access with SSE streaming, session management, and resumability.

## When to Use HTTP Transport

**Use HTTP transport when you need**:
- Remote server access (not just localhost)
- Multiple concurrent clients
- Load balancing across MCP servers
- Integration with reverse proxies (nginx, cloudflare)
- Stateful sessions

**Use stdio transport when you need**:
- Local desktop MCP client
- Simple single-client setup
- Maximum security (no network exposure)

## Quick Start

### Single-User Mode (Simple Setup)

Best for: Testing, development, single-user servers

```bash
# Set environment
export MCP4_TRANSPORT=http
export MCP4_HOST=127.0.0.1  # localhost only (secure default)
export MCP4_PORT=3003
export MCP4_API_TOKEN=your_token
export MCP4_API_BASE_URL=https://api.example.com
export MCP4_PROFILE_PATH=./mcp-profile.json

# Start server
npm start
```

CLI alternative:
```bash
export MCP4_API_TOKEN=your_token
npx mcp4openapi \
  --transport http \
  --host 127.0.0.1 \
  --port 3003 \
  --api-base-url https://api.example.com
  --profile-path ./mcp-profile.json
```

Note: `MCP4_OPENAPI_SPEC_PATH` is optional when the selected profile includes `openapi_spec_path`. If a profile does not provide it, you must set `MCP4_OPENAPI_SPEC_PATH` or `--openapi-spec-path`. In HTTP profile routing mode, `MCP4_OPENAPI_SPEC_PATH` acts as a global fallback for profiles that omit `openapi_spec_path`.

Server will log:
```
{"timestamp":"...","level":"info","message":"HTTP transport started","host":"127.0.0.1","port":3003}
```

**All clients share the same MCP4_API_TOKEN from environment.**

### Multi-User Mode (Remote Access)

Best for: Production, multiple users with different tokens

```bash
# Allow network access
export MCP4_TRANSPORT=http
export MCP4_HOST=0.0.0.0
export MCP4_PORT=3003
export MCP4_API_BASE_URL=https://api.example.com
# Note: No MCP4_API_TOKEN in environment

# Configure allowed origins (for corporate networks)
export MCP4_ALLOWED_ORIGINS="example.com,*.company.com,192.168.1.0/24,10.0.0.0/8,2001:db8::/32"

# Optional: Enable heartbeat for proxy keepalive
export MCP4_HEARTBEAT_ENABLED=true
export MCP4_HEARTBEAT_INTERVAL_MS=30000  # 30 seconds

npx mcp4openapi
```

CLI alternative:
```bash
npx mcp4openapi \
  --transport http \
  --host 0.0.0.0 \
  --port 3003 \
  --api-base-url https://api.example.com \
  --allowed-origins "example.com,*.company.com,192.168.1.0/24,10.0.0.0/8,2001:db8::/32" \
  --heartbeat-enabled true \
  --heartbeat-interval-ms 30000
```

**Each client sends their own token in `Authorization: Bearer <token>` header during initialization.** Alternatively, clients can use OAuth authorization flow for API with OAuth support.

**Security Warning**: When binding to `0.0.0.0`, ensure firewall protection, configure `MCP4_ALLOWED_ORIGINS`, and use HTTPS reverse proxy. Server will log warning if `MCP4_ALLOWED_ORIGINS` is not configured.

### Profile Routing (HTTP)

Enable profile-specific routes to serve multiple profiles from one HTTP server:

```bash
export MCP4_TRANSPORT=http
export MCP4_HTTP_PROFILE_ROUTING=true
export MCP4_HTTP_PROFILE_INDEX=true
export MCP4_ALLOW_PROFILES=gitlab,github
export MCP4_PROFILES_DIR=./profiles
export MCP4_HOST=127.0.0.1
export MCP4_PORT=3003
npx mcp4openapi
```

CLI alternative:
```bash
npx mcp4openapi \
  --transport http \
  --http-profile-routing true \
  --http-profile-index true \
  --allow-profiles gitlab,github \
  --profiles-dir ./profiles \
  --host 127.0.0.1 \
  --port 3003
```

Routes:
- `POST /profile/:profileId/mcp`
- `GET /profile/:profileId/mcp`
- `DELETE /profile/:profileId/mcp`
- Legacy alias: `POST|GET|DELETE /profile/:profileId/sse`
- Optional HTML profile index: `GET /` (when `MCP4_HTTP_PROFILE_INDEX=true`)
  - Set `MCP4_HTTP_PROFILE_INDEX_REDIRECT_URL` to redirect HTML/default requests to another page.
  - Set `MCP4_HTTP_PROFILE_INDEX_REDIRECT_STATUS` to `301` or `302` (default: `302`).
  - Explicit JSON-only requests (`Accept: application/json`) always return the profile index payload and are never redirected.
  - Keeps current API endpoint display semantics (env/default source)
  - Can show admin-supplied raw HTML descriptions from `MCP4_PROFILES_DESCRIPTION` in the detail card before the profile description
  - When tenant config is available for a profile, shows tenant availability and tenant list per profile
  - Includes interactive tenant picker for supported remote snippet formats and injects `X-Mcp4-Tenant-Id` into copied snippet output
  - Includes a per-profile tool catalog with interactive builders for `X-Mcp4-Tools` and `X-Mcp4-Params`
  - While tool or parameter filtering is active, only snippet variants with verified custom-header support remain visible
  - Picker includes an explicit "no tenant" option that keeps snippet headers unchanged
  - For `mask:` tenant selection, picker also injects example `X-Mcp4-Api-Base-Url` with wildcard parts replaced by `<your-part>`
  - In `Local stdio` mode, tenant selection injects tenant API base URL into snippet env config for supported local snippet formats
  - In `Local stdio` mode, active tool/parameter filters are translated into local `mcp4openapi` CLI arguments (`--tool-filter-allow-names`, `--tool-filter-allow-categories`, `--param-filter`) instead of hiding supported local snippets
  - Profiles that use `auth.type: "session-cookie"` are shown only in `Local stdio` snippets because remote HTTP initialization does not accept upstream login/password via request headers

Default profile behavior:
- If `MCP4_PROFILE_PATH` (or `--profile-path`) is set, `/mcp` and `/sse` stay available.
- If no default profile is configured, `/mcp` is not registered and you must use `/profile/:profileId/mcp`.

Allowlist controls (only when routing is enabled):
- `MCP4_ALLOW_PROFILES`: Comma-separated profile ids/names/aliases that can be routed.
- `MCP4_ALLOW_PROFILES_REGEX`: Regex pattern that can match profile ids/names/aliases.
- `MCP4_HIDDEN_PROFILES`: Comma-separated profile ids/names/aliases to hide from the index page (profiles remain fully functional).
- `MCP4_SERVERINFO_SUFFIX`: Optional suffix appended to MCP `serverInfo.title` at startup. The title comes from the active profile's `profile_name`; `serverInfo.name` remains `mcp4openapi`.

Profile index admin descriptions:
- `MCP4_PROFILES_DESCRIPTION`: Optional JSON object mapping `profileId`, `profileName`, or alias to an HTML snippet rendered in the HTML detail card before the profile's own description.
- Parsed once at startup and resolved against the loaded profile catalog.
- Startup fails fast on invalid JSON, non-object payloads, non-string values, duplicate keys resolving to the same profile, or values longer than `10000` characters.
- Keys that do not match any loaded profile are ignored.
- The HTML is rendered only for the HTML index response on `GET /`; the JSON profile index omits this field.
- The content is rendered as raw HTML, so it must be treated as trusted administrator input.

Example:
```bash
export MCP4_HTTP_PROFILE_ROUTING=true
export MCP4_HTTP_PROFILE_INDEX=true
export MCP4_PROFILES_DESCRIPTION='{"gitlab":"<p><strong>Internal:</strong> Use SSO token.</p>","gl":"<p>Alias-based entry also works.</p>"}'
```

OAuth and metadata endpoints are scoped per profile when routing is enabled:
- `/.well-known/oauth-protected-resource/mcp` -> `/profile/:profileId/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server` -> `/profile/:profileId/.well-known/oauth-authorization-server`
- `/oauth/authorize` -> `/profile/:profileId/oauth/authorize`
- `/oauth/token` -> `/profile/:profileId/oauth/token`
- `/oauth/register` -> `/profile/:profileId/oauth/register`
- `/oauth/callback` -> `/profile/:profileId/oauth/callback`

Root protected resource metadata also supports a `resource` query parameter for profile selection:
- `/.well-known/oauth-protected-resource/mcp?resource=http://host/profile/:profileId/mcp`

If no default profile is configured, use the `resource` query parameter to resolve metadata.



### Tenant Session Override (HTTP)

You can configure per-session tenant selection using either:
- `MCP4_HTTP_TENANTS_FILE=/path/to/tenants.json`
- `MCP4_HTTP_TENANTS_JSON={...}`

`api_base_url` selector formats:
- exact: `https://team-a.example.com/api`
- mask: `mask:https://grafana.*.security.*.ops.iszn.cz/api`

Required tenant scoping:
- `profile_ids`: required non-empty array of profile ids where the tenant is active

Header selectors (initialize request only):
- `X-Mcp4-Tenant-Id`: select tenant by `tenant_id`.
- `X-Mcp4-Api-Base-Url`: select tenant by exact or mask selector.

Deterministic resolution order at initialization:
1. `X-Mcp4-Tenant-Id`
2. exact match for `X-Mcp4-Api-Base-Url`
3. `mask:` match for `X-Mcp4-Api-Base-Url`

Mask selector behavior:
- For exact selectors, `X-Mcp4-Tenant-Id` or `X-Mcp4-Api-Base-Url` is sufficient.
- For mask selectors, concrete URL selection requires `X-Mcp4-Api-Base-Url`.
- `X-Mcp4-Tenant-Id` for mask entries is optional guard; when both headers are provided, they must resolve to the same tenant.

Session immutability:
- On non-initialize requests, selector headers are optional.
- If provided, they must match the stored session tenant selection (tenant id and concrete base URL).
- Mismatch returns `400 ValidationError`.
- If no tenant headers are sent, tenant override is skipped and profile-level config is used.

Security and validation rules:
- Tenant base URLs are allowlist-only; unknown selectors are rejected.
- `https` is required by default (`http` only with `MCP4_HTTP_TENANTS_ALLOW_HTTP=true`).
- Credentials, query, and fragment are rejected in selectors.
- `default` tenant property is not supported.
- `mask:` grammar:
  - wildcard `*` is allowed only as a full hostname label
  - literal hostname labels must match `[a-z0-9-]+`
  - wildcard `*` is allowed in path only as a full path segment
  - one `*` path segment matches exactly one concrete path segment
- Startup fail-fast collision checks:
  - exact vs exact with incompatible auth
  - exact vs mask intersection
  - mask vs mask intersection
- Runtime ambiguity guard: if one concrete URL matches multiple mask tenants, request fails with `400 ValidationError`.

Tenant config example (exact + mask):

```json
{
  "version": 1,
  "tenants": [
    {
      "tenant_id": "team-a",
      "profile_ids": ["grafana", "grafana-optimized"],
      "api_base_url": "https://team-a.example.com/api",
      "auth_mode": "token",
      "auth": { "type": "bearer", "value_from_env": "TEAM_A_TOKEN" }
    },
    {
      "tenant_id": "grafana-security",
      "profile_ids": ["grafana-security"],
      "api_base_url": "mask:https://grafana.*.security.*.ops.iszn.cz/api",
      "auth_mode": "token",
      "auth": { "type": "bearer", "value_from_env": "GRAFANA_SECURITY_TOKEN" }
    }
  ]
}
```

### Reverse Proxy Support

If you run behind a reverse proxy that sets `X-Forwarded-For`, enable Express trust proxy so rate limiting and OAuth flows work correctly:

```bash
export MCP4_TRUST_PROXY=1
```

## MCP Protocol Compliance

This implementation follows **MCP Specification 2025-03-26** for Streamable HTTP transport.

Source: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports

### Supported Features

- Single MCP endpoint (`/mcp`) for POST + GET
- JSON-RPC request/notification/response handling
- Batch requests (JSON-RPC arrays)
- SSE streaming responses
- Session management (`Mcp-Session-Id` header)
- Resumability (`Last-Event-ID` header)
- Origin validation (DNS rebinding protection)
- Session termination (DELETE endpoint)
- Accept header validation

## API Endpoints

### POST /mcp - Send Messages

**Purpose**: Client sends JSON-RPC messages to server

**Headers**:
- `Content-Type: application/json` (required)
- `Accept: application/json` or `text/event-stream` (required)
- `Mcp-Session-Id: <session-id>` (required except for initialization)
- `Authorization: Bearer <token>` or `X-API-Token: <token>` (required for initialization if not using env var)
  - If the active profile uses `auth.type: "token"` (DRF Token auth), clients send `Authorization: Token <key>` instead of `Authorization: Bearer <key>`.
  - If the active profile uses `auth.type: "custom-header"`, clients can send the configured header name (for example `X-N8N-API-KEY`) with the token instead of `Authorization` or `X-API-Token`.
  - The header name comes from the profile auth configuration, so it can vary per profile.
  - Supports various token formats: GitLab (`glpat-...`), YouTrack (`perm:...`), generic tokens
  - Flexible whitespace handling (extra spaces are trimmed)
  - If the active profile uses `auth.type: "session-cookie"`, upstream authentication is handled by the server using the profile's `session_cookie_config` credentials, so an initialization token header is not required unless another auth method is active for that profile.
- `X-Mcp4-Params: <filter>` (optional)
- `X-Mcp4-Tools: <tool-filter>` (optional)
  - If sent during initialization, the server stores the normalized header value in the session.
  - Subsequent requests may omit the header, but if provided it must match the session value or the server returns `400`.

**Parameter Filtering header format**:
- Comma-separated list of `key=value` items
- Control keys (no value):
  - `_allow_list`: for list operations, allow omitting the filtered key and allow any value if the key is present.
  - `_allow_read`: for read operations, allow omitting the filtered key and allow any value if the key is present.
  - Control keys do not relax modify operations (write remains constrained by the allowed set).
- Values containing spaces or commas must be percent-encoded
- Key pattern: `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`

**Example**:
```
X-Mcp4-Params: project_id=123, project_id=456, _allow_read
```

**Global baseline**:
- `MCP4_PARAM_FILTER` uses the same syntax and applies process-wide.
- If both `MCP4_PARAM_FILTER` and `X-Mcp4-Params` are set, the session header may only narrow the global baseline.
- Conflicting overlaps fail during session initialization.

**Tool filtering header format**:
- Comma-separated list of tool names or regex entries
- Regex entries must be prefixed with `regex:` and are auto-anchored unless already wrapped with `^` and `$`
- Max entries default is 100, max entry length is 255 characters
- Control keywords (tools categories, session initialization only):
  - `_allow_list`: allow tools detected as **list** category (GET without path params)
  - `_allow_read`: allow tools detected as **read** category (GET with path params)
  - These keywords are **only allowed during session initialization**. The server stores the normalized header value in the session. Subsequent requests may omit the header, but if provided it must match the session value or the server returns `400`.
  - Other `_allow_*` keywords are rejected with an error suggesting `X-Mcp4-Params`.

**Important**: In `X-Mcp4-Tools`, `_allow_list/_allow_read` control **which tools are available** (tool categories). In `X-Mcp4-Params`, `_allow_list/_allow_read` control **parameter filtering behavior** for list/read operations.

**Example**:
```
X-Mcp4-Tools: get_user, list_users, regex:read_.*
```

Regex patterns are validated for length, nested quantifiers, and alternations with quantifiers.

**Request Body**:
- Single JSON-RPC request/notification/response
- Or array (batch) of requests/notifications/responses

**Response**:
- **HTTP 200** with JSON response (if `Accept: application/json`)
- **HTTP 200** with SSE stream (if `Accept: text/event-stream`)
- **HTTP 202** (no body) for notification-only messages
- **HTTP 400/404/500** for errors

**Example - Initialize**:
```bash
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer your_gitlab_token" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "clientInfo": {
        "name": "my-client",
        "version": "1.0.0"
      }
    }
  }'
```

**Alternative with X-API-Token header**:
```bash
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "X-API-Token: your_gitlab_token" \
  -d '{...}'
```

**Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-03-26",
    "serverInfo": {
      "name": "mcp4openapi",
      "version": "0.1.0",
      "title": "gitlab-optimized"
    },
    "capabilities": {
      "tools": {}
    }
  }
}
```

`serverInfo.title` is built from the loaded profile's `profile_name` and optionally appends `MCP4_SERVERINFO_SUFFIX`. If the profile has no usable `profile_name`, initialization still fails fast instead of falling back to another identifier.

**Response Headers**:
```
Mcp-Session-Id: <generated-session-id>
```

**Example - List Tools**:
```bash
SESSION_ID="<session-id-from-init>"

curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

**Example - Call Tool**:
```bash
curl -X POST http://localhost:3003/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "manage_project_badges",
      "arguments": {
        "action": "list",
        "project_id": "123"
      }
    }
  }'
```

### GET /mcp - Open SSE Stream

**Purpose**: Open Server-Sent Events stream for server-initiated messages

**Headers**:
- `Accept: text/event-stream` (required)
- `Mcp-Session-Id: <session-id>` (required)
- `Last-Event-ID: <event-id>` (optional, for resuming)

**Response**:
- **HTTP 200** with SSE stream (`Content-Type: text/event-stream`)
- **HTTP 400/404/405** for errors

**Example**:
```bash
curl -N -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  http://localhost:3003/mcp
```

**SSE Format**:
```
id: 1234567890123
data: {"jsonrpc":"2.0","method":"notification","params":{}}

id: 1234567890124
data: {"jsonrpc":"2.0","method":"another","params":{}}
```

**Heartbeat** (if enabled):
```
:ping
```

### DELETE /mcp - Terminate Session

**Purpose**: Explicitly terminate session and cleanup resources

**Headers**:
- `Mcp-Session-Id: <session-id>` (required)

**Response**:
- **HTTP 204** (no content) on success
- **HTTP 400/404** for errors

**Example**:
```bash
curl -X DELETE http://localhost:3003/mcp \
  -H "Mcp-Session-Id: $SESSION_ID"
```

### GET /health - Health Check

**Purpose**: Check server health and session count

**Response**:
```json
{
  "status": "ok",
  "sessions": 5
}
```

**Example**:
```bash
curl http://localhost:3003/health
```

### Legacy `/sse` alias (deprecated) {#legacy-sse-alias}

> **⚠️ Deprecated**: This endpoint is maintained for backward compatibility only. Use `/mcp` endpoints instead.

For clients expecting the `/sse` endpoint, the server provides a deprecated alias that logs warnings and delegates to the `/mcp` endpoints.

**Supported methods**: POST, GET, DELETE

**All headers, request/response formats, and behavior are identical to `/mcp` endpoints.**

**Example - Initialize (deprecated)**:
```bash
curl -X POST http://localhost:3003/sse \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer your_token" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "clientInfo": {
        "name": "my-client",
        "version": "1.0.0"
      }
    }
  }'
```

**Response**: Same as `/mcp` POST
```
Mcp-Session-Id: <generated-session-id>
```

**Example - Open SSE Stream (deprecated)**:
```bash
SESSION_ID="<session-id-from-init>"
curl -N -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  http://localhost:3003/sse
```

**Example - Terminate Session (deprecated)**:
```bash
curl -X DELETE http://localhost:3003/sse \
  -H "Mcp-Session-Id: $SESSION_ID"
```

**Migration**: Replace `/sse` with `/mcp` in all client code. No other changes required.

## Session Management

### Session Lifecycle

1. **Created**: On initialization (POST with `method: "initialize"`)
2. **Active**: Session ID in `Mcp-Session-Id` header
3. **Expired**: After `MCP4_SESSION_TIMEOUT_MS` of inactivity (default: 30 minutes)
4. **Terminated**: Explicit DELETE or server shutdown

### Session Timeout

```bash
export MCP4_SESSION_TIMEOUT_MS=1800000  # 30 minutes (default)
export MCP4_SESSION_TIMEOUT_MS=3600000  # 1 hour
export MCP4_SESSION_TIMEOUT_MS=600000   # 10 minutes
```

**Behavior**:
- Activity tracked on every request
- Expired sessions automatically cleaned up (every 1 minute)
- Expired session requests return **HTTP 404**

**OAuth Sessions**:

OAuth sessions with refresh tokens have extended timeouts to avoid forcing users to re-authenticate after periods of inactivity:

- **Default OAuth session timeout**: 24 hours (configurable via `MCP4_OAUTH_SESSION_TIMEOUT_MS`)
- **Unlimited timeout**: Set `MCP4_OAUTH_SESSION_TIMEOUT_MS=0` to never expire OAuth sessions
- **Automatic token refresh**: Access tokens are automatically refreshed before expiration (60 seconds before by default, configurable via `MCP4_OAUTH_REFRESH_THRESHOLD_MS`)

**Why extended timeout for OAuth?**

- OAuth access tokens are short-lived (15-60 minutes) for security
- Refresh tokens allow automatic renewal without user intervention
- Extended session timeout prevents unnecessary re-authentication after idle periods
- Users don't need to restart MCP in their IDE when tokens expire

**Configuration**:
```bash
# OAuth session timeout: 24 hours (default)
export MCP4_OAUTH_SESSION_TIMEOUT_MS=86400000

# Unlimited OAuth session timeout (never expire)
export MCP4_OAUTH_SESSION_TIMEOUT_MS=0

# Refresh token 60 seconds before expiration (default)
export MCP4_OAUTH_REFRESH_THRESHOLD_MS=60000
```

### Session Storage

Sessions store:
- Session ID (crypto-secure UUID)
- Creation timestamp
- Last activity timestamp
- Active SSE streams (for resumability)

## Encrypted Token Envelopes

When `MCP4_OAUTH_KEY` is configured, the gateway wraps OAuth tokens in encrypted envelopes so MCP
clients can survive arbitrary gateway restarts (for example k8s pod evictions) without re-running
the OAuth browser flow.

### Token format

```
mcp4.v1.<base64url(12-byte-nonce + AES-256-GCM-ciphertext + 16-byte-tag)>
```

- Algorithm: AES-256-GCM with a fresh 12-byte random nonce per token.
- Additional Authenticated Data (AAD): the profile_id as UTF-8 bytes. This binds an envelope to
  exactly one profile and prevents cross-profile replay.
- Payload (encrypted): IdP access_token, IdP refresh_token (optional), expiry, OAuth client_id,
  scopes, profile_id, issued-at timestamp, and an optional OAuth client registration snapshot
  (creg) so the client does not need to re-register on restart.
- `client_secret` is NEVER embedded - DCR clients are public PKCE clients without one.

### When envelopes are issued

The gateway returns an envelope as `access_token` in the `/oauth/token` response only when ALL of:
1. `MCP4_OAUTH_KEY` is configured at startup.
2. The IdP returned a `refresh_token` (envelopes without a refresh path provide no recovery
   benefit, so plain access_token is returned instead).

If encryption fails for any reason, the gateway logs a warn and falls back to the plain IdP
access_token - the response shape is unchanged. Clients ALWAYS work, with or without envelopes.

### Restart-recovery flow

1. The MCP client stores the `mcp4.v1.*` token from the OAuth response.
2. The gateway is restarted (k8s rolling deploy, OOM kill, etc.) and all in-memory state is lost.
3. The client reconnects and re-presents the same envelope on the next MCP `initialize` request.
4. The gateway detects the `mcp4.v1.` prefix, decrypts using `MCP4_OAUTH_KEY` and the
   request-profile_id (as AAD). On success, it rehydrates the session: refresh_token, expiry,
   client_id, scopes, and (if creg is present) the OAuth client registration in memory.
5. If the access token is already expired, the existing refresh-token path silently exchanges
   it for a fresh access token in the next request - the client sees no auth challenge.

### Key derivation (`MCP4_OAUTH_KEY`)

- 64-char hex string: decoded directly as 32 raw bytes (AES-256 key).
- Anything else: scrypt(value, fixed application salt, 32 bytes) - any passphrase works.
  Envelopes issued before the scrypt migration (SHA-256-derived keys) still decrypt via a
  legacy fallback key; new envelopes are always scrypt-derived (fallback removal: TODO.md #18).
- Whitespace around the value is trimmed before derivation (k8s ConfigMap newline tolerance).
- Unset: plain-token mode is active and a startup warn is logged. Behavior matches earlier
  releases byte-for-byte.

### Limitation: rotating refresh tokens

If your IdP issues rotating refresh tokens AND the gateway restarts after at least one in-session
token refresh, the client still holds the original envelope with the now-stale `rt`. Re-auth is
required in that case (same as today). For non-rotating refresh tokens, zero-reauth across
arbitrary restarts is supported.

### Security boundary

- The AES-GCM auth tag IS the integrity signature - any tamper to nonce, ciphertext, or tag
  produces a `null` decrypt result, NOT a partial recovery.
- profile_id is bound as AAD AND post-decrypt-validated - even an attacker who possessed the
  symmetric key could not present a profile-A envelope to profile-B.
- All decrypt failures are silent (debug log only) - the session falls back to plain-bearer
  treatment without a 500 or 401.

## Consent Gate

A profile with `consent_gate.required: true` blocks every upstream MCP dispatch until the
authenticated human has accepted the current rules. Profile shape and validation rules live in the
[Profile Guide](./PROFILE-GUIDE.md#consent-gated-upstream-mcp); the browser side of the flow is in
[docs/OAUTH.md](./OAUTH.md#consent-gated-profiles).

### Enforcement point

`MCPServer.setGetUpstreamClient()` wraps the injected connection factory with the consent guard.
The wrapped function is the only place where an upstream client is acquired, so `tools/list` and
`tools/call` run the same check and cannot diverge; a new dispatch path inherits the gate
automatically, and single-profile HTTP mode (`runHttp`) and multi-profile routing mode
(`MCPServerManager`) share the same chokepoint. Consent-gated profiles refuse to start on the
stdio transport (`runStdio` throws `ConsentGateConfigurationError`) because consent can only be
granted via the HTTP OAuth flow.

Order per dispatch (`src/mcp/mcp-server.ts`):

1. `server.isConsentRequired()` - false means no check and no store read.
2. `HttpTransport.assertSessionConsent(profileId, sessionId)` - resolves the session principal and
   delegates to `ConsentGate`.
3. `UpstreamConnectionManager.getOrConnect(...)` - reached only after the gate passes.

Fail-closed cases, all of which block the call:

- No enforcer reachable (for example an `MCPServerManager` constructed without an HTTP transport):
  `ConsentGateConfigurationError`.
- The profile declares `consent_gate.required` but no gate was constructed: `ConsentGateConfigurationError`.
- The session has no verified principal (anonymous, or an OAuth token stored without a verified OIDC
  identity): denial reason `no_principal`.
- The evidence store cannot be read or written: `ConsentEvidenceStoreError` propagates instead of
  being swallowed.

There is no positive-result cache. Every dispatch reads the evidence store, so a revocation takes
effect on the next tool call.

### What the client sees on denial

A denied dispatch returns a JSON-RPC error:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32004,
    "message": "Consent required",
    "data": {
      "profileId": "softeria-sharepoint",
      "rules_version": "v1",
      "consent_url": "https://gateway.example/profile/softeria-sharepoint/consent",
      "education_resource": "https://intranet.example/ms365-ai-rules",
      "correlationId": "..."
    }
  }
}
```

`education_resource` appears only when the profile defines it. `consent_url` serves a static HTML page
explaining that the user must reconnect the MCP server in the client to start the sign-in and consent
flow; the page never grants consent by itself.

The specific denial reason (`no_principal`, `auth_type_mismatch`, `issuer_mismatch`, `no_evidence`,
`rules_changed`, `rules_rollback`, `expired`, `revoked`) is deliberately not in `data`. It is written to
the server log only, because telling an unauthenticated caller that its issuer did not match leaks
configuration. Read it from the `Consent required: blocking tool dispatch` debug entry and from the
`Session invalidated to trigger re-consent` info entry; both log a pseudonymized subject, never the raw
`sub`.

### One re-consent 401 per subject and rules version

MCP clients have no "re-consent" verb. The only mechanism they implement is restarting OAuth after a
401. So on the first denial for a given subject and rules version the gateway destroys the session and
deletes its inbound token, which makes the next request unauthenticated and produces
`401` with a `WWW-Authenticate: Bearer resource_metadata=..., scope=...` header. The client then re-runs
the OAuth flow and passes through the rules acknowledgement again.

This is bounded on purpose:

- The invalidation budget key is `profileId + subject (or sessionId when anonymous) + rules_version`.
  Once used, later denials for the same key return `-32004` without destroying the session again, so a
  client that cannot complete the browser acknowledgement does not loop through OAuth forever.
- The budget set is capped at 10000 entries; on overflow the oldest entry is evicted. Overflow costs at
  most one extra invalidation for the evicted subject and never a missed denial.
- A `rules_version` bump produces a new key, so a genuine rules change gets exactly one fresh 401 per
  subject.
- Session teardown failures are logged and swallowed, but the session entry is removed regardless, so a
  client can never keep a usable session after a denial.

### Approval flow needs sticky sessions

The rules acknowledgement is a two-request handshake on the profile authorize endpoint:

1. `GET /profile/<id>/oauth/authorize` renders an HTML form with the rules summary, the education link,
   and a required checkbox. The gateway stores a pending approval keyed by a SHA-256 fingerprint of
   `profile_id` plus the OAuth request fields (`response_type`, `client_id`, `redirect_uri`, `scope`,
   `state`, `code_challenge`, `code_challenge_method`) and sets a random 32-byte browser id in a
   `__Host-mcp4_consent` cookie (`Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax`).
2. `POST /profile/<id>/oauth/authorize` must carry `consent_accept=yes`, the identical OAuth fields, and
   the same cookie. The pending entry is consumed on first use (deleted before the expiry and cookie
   checks) and lives 5 minutes. Only then does the request continue to the IdP authorize redirect.

Pending approvals live in the memory of the process that rendered the form. Behind a load balancer, the
GET and the POST must reach the same replica: configure sticky sessions (for example
`nginx ip_hash`, or cookie-based affinity on the ingress). A POST that lands elsewhere, arrives after
5 minutes, is replayed, or comes from a different browser gets `400` with an HTML page linking back to
the same authorize URL so the user can restart instead of hitting a dead end.

Because the pending entry is keyed by request fingerprint rather than by a shared slot, a flood of
unauthenticated GETs for distinct OAuth requests is bounded by expiry and cannot evict another user's
pending approval.

### Consent Gate Operations

Operational constraints for a deployment with `consent_gate.required: true`. Other documents link here
instead of repeating them.

- **Single node only.** `FileConsentEvidenceStore` (`MCP4_CONSENT_EVIDENCE_PATH`) is an append-only
  JSONL file on local disk. It reloads external writes and appends with `O_APPEND` so concurrent writers
  do not interleave partial lines, but cross-writer deduplication is best effort: two replicas can append
  the same grant, and the index keeps the earliest. Run one gateway instance against one evidence file.
- **Sticky sessions.** The approval handshake above is in-memory per replica. Without affinity, every POST
  that lands on a replica other than the one that rendered the form gets the `400` "Consent approval
  expired" page.
- **Evidence file growth.** Every grant and every revocation is one JSON line, appended forever;
  duplicate grants are suppressed at write time, but revocations and re-grants after a `rules_version`
  bump keep accumulating. Above 32 MiB (`EVIDENCE_MAX_BYTES`) further writes fail closed with
  `ConsentEvidenceStoreError` ("Consent evidence file exceeded its size limit"), which means new grants
  can no longer be recorded. There is no automatic rotation or compaction: monitor the file size and
  compact manually (stop the gateway, keep the newest revocation and the earliest surviving grant per
  subject + issuer + tenant + profile + rules version, write the file back with mode `0600`, restart).
  Treat the file as an audit trail: archive what you drop.
- **File permissions.** The directory is created `0700` and the file `0600`; an existing file with wider
  permissions is tightened on first write. Back it up like a credential store, not like a log.
- **Multi-replica is a follow-up.** A transactional backend with a unique key on subject + canonical
  issuer + tenant + profile + rules version is tracked as `TODO.md` item 1 and slots in behind the same
  `ConsentEvidenceStore` interface, without a call-site change.

### Revoking one subject's consent

The store supports revocation, but nothing exposes it yet: there is no CLI command and no admin
endpoint. Until one exists, an operator revokes by appending a revocation record to the evidence file.
A revocation applies to every `rules_version` for that identity and profile, and takes effect on the
next dispatch because consent results are never cached.

```bash
# Values must match the grant exactly: sub, issuer (canonical form) and tenantId.
# tenantId is null when the issuer provided none. revoked_at is epoch milliseconds.
printf '%s\n' '{"type":"revocation","sub":"<oid>","issuer":"https://login.microsoftonline.com/<tid>/v2.0","tenantId":"<tid>","profileId":"softeria-sharepoint","revoked_at":'"$(date +%s000)"',"reason":"offboarded"}' \
  >> "$MCP4_CONSENT_EVIDENCE_PATH"
```

A grant recorded after the revocation timestamp wins, so the subject can consent again through the
normal browser flow without editing the file. To find the stored identity values, grep the file for the
subject's pseudonym source: logs carry only `pseudonymizeSubject(sub)`, so map from your directory
rather than from the gateway logs.

### Evidence record format and compatibility

Each line is one JSON object with a `type` discriminator: `grant`
(`sub`, `issuer`, `tenantId`, `profileId`, `rules_version`, `rules_hash`, `granted_at`) or `revocation`
(`sub`, `issuer`, `tenantId`, `profileId`, `revoked_at`, optional `reason`). Lines that fail this shape
are skipped with a `Skipped malformed consent evidence lines` warning and can never satisfy a lookup.

That is deliberate and it is the upgrade policy: records written before the current shape (no `type`,
no `rules_hash`, or no issuer binding) are ignored rather than trusted, so a format change forces every
subject to grant consent once more instead of silently accepting an unpinned or unbound grant. Plan a
format change as a re-consent event.

## SSE Resumability

Resume SSE streams after network disconnection.

### How It Works

1. **Server**: Assigns unique `id` to each SSE event
2. **Client**: Tracks last received event ID
3. **Reconnect**: Client sends `Last-Event-ID` header
4. **Server**: Replays missed events (last 100 per stream)

### Example

**Initial connection**:
```bash
curl -N -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  http://localhost:3003/mcp
```

**Resume after disconnect**:
```bash
LAST_EVENT_ID="1234567890123"

curl -N -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -H "Last-Event-ID: $LAST_EVENT_ID" \
  http://localhost:3003/mcp
```

Server replays events with `id > 1234567890123`.

## Heartbeat Configuration

Keep SSE connections alive through reverse proxies.

```bash
export MCP4_HEARTBEAT_ENABLED=true
export MCP4_HEARTBEAT_INTERVAL_MS=30000  # 30 seconds
```

**Why**: Proxies (nginx, cloudflare) timeout idle connections
**How**: Sends `:ping\n\n` comments (ignored by clients)
**Default**: Disabled (enable only if needed)

## Security

### Origin Validation

**Purpose**: Prevent DNS rebinding attacks

**Behavior**:
- Validates `Origin` header for non-localhost requests
- Always allows: `localhost`, `127.0.0.1`, configured `MCP4_HOST`
- Additionally allows: Origins in `MCP4_ALLOWED_ORIGINS` (if configured)
- Rejects: Other origins with **HTTP 403**

**Default Configuration**:
- `MCP4_ALLOWED_ORIGINS` is empty by default
- Server binds to `localhost` (127.0.0.1) by default
- **Warning logged** if binding to non-localhost with empty `MCP4_ALLOWED_ORIGINS`

**Supported Formats**:

```bash
# Exact hostname
export MCP4_ALLOWED_ORIGINS="example.com,api.example.com"

# Wildcard subdomain (*.domain.com)
export MCP4_ALLOWED_ORIGINS="*.company.com"  # Matches: api.company.com, web.company.com

# IPv4 CIDR range (for corporate networks)
export MCP4_ALLOWED_ORIGINS="192.168.1.0/24"  # Matches: 192.168.1.1 - 192.168.1.254
export MCP4_ALLOWED_ORIGINS="10.0.0.0/8"      # Matches: 10.0.0.0 - 10.255.255.255
# IPv6 CIDR range
export MCP4_ALLOWED_ORIGINS="2001:db8::/32"   # Matches: 2001:db8:: - 2001:db8:ffff:ffff:ffff:ffff:ffff:ffff

# Combination (comma-separated)
export MCP4_ALLOWED_ORIGINS="example.com,*.company.com,192.168.1.0/24,10.0.0.0/8,2001:db8::/32"
```

**Examples**:

```bash
# Allow specific subdomain
MCP4_ALLOWED_ORIGINS="api.company.com"

# Allow all company subdomains
MCP4_ALLOWED_ORIGINS="*.company.com"

# Allow branch offices (private networks)
MCP4_ALLOWED_ORIGINS="192.168.1.0/24,192.168.2.0/24,192.168.3.0/24"

# Allow entire corporate /8 network
MCP4_ALLOWED_ORIGINS="10.0.0.0/8"

# Allow IPv6 segment
MCP4_ALLOWED_ORIGINS="2001:db8::/32"

# Mixed: public domains + private networks
MCP4_ALLOWED_ORIGINS="example.com,*.company.com,192.168.0.0/16,10.0.0.0/8,2001:db8::/32"
```

**Skip**: Requests to `localhost` hostname always allowed without additional configuration

### Localhost Binding

**Default**: Server binds to `127.0.0.1` (localhost only)

```bash
export MCP4_HOST=127.0.0.1  # Secure (default)
export MCP4_HOST=0.0.0.0    # Network access (use with caution!)
```

**Security Warning**: When binding to non-localhost address without `MCP4_ALLOWED_ORIGINS` configured, server logs warning. Always set `MCP4_ALLOWED_ORIGINS` when exposing server to network or bind to `localhost`.

**Default `MCP4_ALLOWED_ORIGINS`**: Empty (no origins allowed except localhost).

### Best Practices

1. **Localhost first**: Use `127.0.0.1` unless remote access needed
2. **HTTPS reverse proxy**: Use traefik/nginx/caddy with TLS for remote access
3. **Firewall**: Restrict port access to trusted IPs
4. **Strong tokens**: Use cryptographically secure API tokens
5. **Monitor sessions**: Check `/health` endpoint regularly

## Reverse Proxy Setup

### nginx Example

```nginx
server {
    listen 443 ssl http2;
    server_name mcp.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        
        # SSE support
        proxy_set_header Connection '';
        chunked_transfer_encoding off;
        proxy_buffering off;
        proxy_cache off;
        
        # Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 3600s;  # 1 hour for SSE
    }
}
```

**Enable heartbeat** to prevent proxy timeouts:
```bash
export MCP4_HEARTBEAT_ENABLED=true
```

## Troubleshooting

### Session not found (404)

**Cause**: Session expired or never initialized
**Solution**: Initialize first, check `MCP4_SESSION_TIMEOUT_MS`

```bash
# Check timeout
echo $MCP4_SESSION_TIMEOUT_MS

# Increase if needed
export MCP4_SESSION_TIMEOUT_MS=3600000  # 1 hour
```

### Origin not allowed (403)

**Cause**: Origin validation rejected request
**Solution**: Check Origin header, use allowed origin

```bash
# Check logs for rejected origin
# Add origin to allowlist or use localhost
```

### Connection timeout

**Cause**: Proxy timing out SSE stream
**Solution**: Enable heartbeat

```bash
export MCP4_HEARTBEAT_ENABLED=true
export MCP4_HEARTBEAT_INTERVAL_MS=30000
```

### Server not accessible remotely

**Cause**: Binding to localhost only
**Solution**: Bind to network interface

```bash
export MCP4_HOST=0.0.0.0  # or specific IP
```

**Warning**: Ensure firewall protection!

## Monitoring

### Prometheus Metrics

**Enable metrics** for production observability:

```bash
export MCP4_METRICS_ENABLED=true
export MCP4_METRICS_PATH=/metrics  # Optional, default: /metrics
npm start
```

**Metrics endpoint**:
```bash
curl http://localhost:3003/metrics
```

**Available metrics**:

```prometheus
# HTTP metrics
mcp_http_requests_total{method,path,status,profile_id,tenant_id}
mcp_http_request_duration_seconds{method,path,status,profile_id,tenant_id}

# Session metrics
mcp_sessions_active{profile_id,tenant_id}
mcp_sessions_created_total{profile_id,tenant_id}
mcp_sessions_destroyed_total{profile_id,tenant_id}

# Tool call metrics
mcp_tool_calls_total{tool,status,profile_id,tenant_id}
mcp_tool_call_duration_seconds{tool,status,profile_id,tenant_id}
mcp_tool_call_errors_total{tool,error_type,profile_id,tenant_id}

# API call metrics (to backend)
mcp_api_calls_total{operation,status,profile_id,tenant_id}
mcp_api_call_duration_seconds{operation,status,profile_id,tenant_id}
mcp_api_call_errors_total{operation,error_type,profile_id,tenant_id}
```

**Prometheus scrape config**:

```yaml
scrape_configs:
  - job_name: 'mcp-server'
    static_configs:
      - targets: ['<your-mcp-server-host>']
    MCP4_METRICS_PATH: '/metrics'
    scrape_interval: 15s
```

**Grafana dashboard ideas**:
- Request rate & latency (p50, p95, p99)
- Active sessions over time
- Tool call success rate
- Backend API error rate
- Session timeout rate

### Health Endpoint

```bash
curl http://localhost:3003/health
```

Response:
```json
{
  "status": "ok",
  "sessions": 3
}
```

Monitor `sessions` count to detect leaks or issues.

### Structured Logging

**JSON format** (for log aggregation):
```bash
export MCP4_LOG_FORMAT=json
npm start
```

**Console format** (for debugging):
```bash
export MCP4_LOG_FORMAT=console
npm start
```

## Rate Limiting

### Global Rate Limit

Default rate limit applies to all API operations:

```bash
MCP4_HTTP_RATE_LIMIT_MAX_REQUESTS=600  # per minute
MCP4_HTTP_RATE_LIMIT_WINDOW_MS=60000   # 60 seconds
```

**Default**: 600 requests/minute per API token

### Per-Endpoint Rate Limiting

Override rate limits for specific operations in your profile:

```json
{
  "http_client": {
    "rate_limit": {
      "max_requests_per_minute": 600,
      "overrides": {
        "postApiV4ProjectsIdIssues": {
          "max_requests_per_minute": 10
        },
        "deleteApiV4ProjectsIdIssuesIssueIid": {
          "max_requests_per_minute": 5
        }
      }
    }
  }
}
```

**How it works:**
- Rate limits are enforced **per API token**
- Token bucket algorithm allows bursts
- 429 responses trigger automatic retry with backoff

### Security Recommendations

Different operation types should have different limits:

| Operation Type | Recommended Limit | Reason |
|---------------|-------------------|---------|
| **Read** (GET) | 120-600 req/min | Low abuse risk |
| **Write** (POST, PUT) | 10-20 req/min | Prevent spam |
| **Delete** | 5-10 req/min | Destructive operations |
| **Batch** | 1-5 req/min | Resource intensive |

**Why per-endpoint limits:**
- Prevents spam (e.g., mass issue creation)
- Protects against DoS attacks
- Enforces API quotas
- Allows burst traffic for reads

### Rate Limit Headers

Responses include rate limit information:

```http
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 573
X-RateLimit-Reset: 1634567890
```

### Handling Rate Limits

When rate limited (429 response):

1. **Automatic retry**: HTTP client retries with exponential backoff
2. **Backoff schedule**: 1s → 2s → 4s
3. **Max attempts**: 3 (configurable in profile)

```json
{
  "http_client": {
    "retry": {
      "max_attempts": 3,
      "backoff_ms": [1000, 2000, 4000],
      "retry_on_status": [429, 502, 503, 504]
    }
  }
}
```

## Performance

### Concurrent Clients

HTTP transport supports multiple concurrent clients with separate sessions.

**Tested**: 100+ concurrent sessions
**Limit**: System resources (memory, file descriptors)

### Session Cleanup

Expired sessions cleaned every 60 seconds.

**Memory**: ~1KB per session (approx)
**Recommendation**: Monitor with `/health` endpoint

### SSE Message Queue

Each stream buffers last 100 messages for resumability.

**Memory**: ~10KB per active stream (approx)
**Recommendation**: Close unused streams

## Examples

See [EXAMPLE-GITLAB.md](../EXAMPLE-GITLAB.md) for complete curl-based examples with GitLab API.

## Related Documentation

- [README.md](../README.md) - Project overview
- [PROFILE-GUIDE.md](./PROFILE-GUIDE.md) - Creating profiles
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) - Official spec
