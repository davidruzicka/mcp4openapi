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
  - Keeps current API endpoint display semantics (env/default source)
  - When tenant config is available for a profile, shows tenant availability and tenant list per profile
  - Includes interactive tenant picker for supported remote snippet formats and injects `X-Mcp4-Tenant-Id` into copied snippet output
  - Includes a per-profile tool catalog with interactive builders for `X-Mcp4-Tools` and `X-Mcp4-Params`
  - While tool or parameter filtering is active, only snippet variants with verified custom-header support remain visible
  - Picker includes an explicit "no tenant" option that keeps snippet headers unchanged
  - For `mask:` tenant selection, picker also injects example `X-Mcp4-Api-Base-Url` with wildcard parts replaced by `<your-part>`
  - In `Local stdio` mode, tenant selection injects tenant API base URL into snippet env config for supported local snippet formats

Default profile behavior:
- If `MCP4_PROFILE_PATH` (or `--profile-path`) is set, `/mcp` and `/sse` stay available.
- If no default profile is configured, `/mcp` is not registered and you must use `/profile/:profileId/mcp`.

Allowlist controls (only when routing is enabled):
- `MCP4_ALLOW_PROFILES`: Comma-separated profile ids/names/aliases that can be routed.
- `MCP4_ALLOW_PROFILES_REGEX`: Regex pattern that can match profile ids/names/aliases.

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
  - If the active profile uses `auth.type: "custom-header"`, clients can send the configured header name (for example `X-N8N-API-KEY`) with the token instead of `Authorization` or `X-API-Token`.
  - The header name comes from the profile auth configuration, so it can vary per profile.
  - Supports various token formats: GitLab (`glpat-...`), YouTrack (`perm:...`), generic tokens
  - Flexible whitespace handling (extra spaces are trimmed)
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
      "version": "0.2.9"
    },
    "capabilities": {
      "tools": {}
    }
  }
}
```

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
