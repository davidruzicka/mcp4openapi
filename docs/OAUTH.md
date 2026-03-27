# OAuth 2.0 Authentication Guide

This guide explains how to configure OAuth 2.0 authentication for mcp4openapi.

## Enterprise managed authorization

HTTP transport also supports enterprise-managed authorization through a profile-level `enterprise_authorization` block. This is separate from `interceptors.auth`: `interceptors.auth` configures how mcp4openapi authenticates to the upstream API, while `enterprise_authorization` configures how HTTP clients authenticate to mcp4openapi.

Use the JWT bearer grant on `/oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and an `assertion` parameter. The server validates the configured issuer/JWKS over HTTPS, enforces replay protection and size/TTL limits, then mints an opaque MCP bearer token instead of returning the raw enterprise JWT.

Minimal profile example:

```json
{
  "profile_name": "enterprise-http",
  "enterprise_authorization": {
    "enabled": true,
    "issuer": {
      "issuer": "https://issuer.example.com",
      "jwks_uri": "https://issuer.example.com/.well-known/jwks.json",
      "allowed_algs": ["RS256"]
    },
    "token_exchange": {
      "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
      "required_typ": ["at+jwt"],
      "required_claims": ["sub"]
    },
    "access_policy": {
      "scopes_supported": ["api"],
      "default_scopes": ["api"]
    }
  }
}
```

Env-backed enterprise authorization fields let you keep deployment-specific values outside the profile while preserving static fallbacks in the profile itself.

```json
{
  "profile_name": "enterprise-http",
  "enterprise_authorization": {
    "enabled": true,
    "mode": "required",
    "mode_from_env": "ENTERPRISE_MODE",
    "issuer": {
      "issuer": "https://issuer.example.com",
      "issuer_from_env": "ENTERPRISE_ISSUER",
      "jwks_uri": "https://issuer.example.com/.well-known/jwks.json",
      "jwks_uri_from_env": "ENTERPRISE_JWKS_URI",
      "allowed_algs": ["RS256"],
      "allowed_algs_from_env": "ENTERPRISE_ALLOWED_ALGS"
    },
    "token_exchange": {
      "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
      "allowed_client_ids": ["enterprise-client"]
    },
    "access_policy": {
      "scopes_supported": ["api", "admin"],
      "default_scopes": ["api"],
      "default_scopes_from_env": "ENTERPRISE_DEFAULT_SCOPES",
      "allowed_tool_categories_from_env": "ENTERPRISE_ALLOWED_TOOL_CATEGORIES",
      "claim_mappings_from_env": "ENTERPRISE_CLAIM_MAPPINGS_JSON"
    }
  }
}
```

Supported env-backed fields:

- `mode_from_env`
- `audience_from_env`
- `issuer.issuer_from_env`
- `issuer.jwks_uri_from_env`
- `issuer.allowed_algs_from_env`
- `access_policy.default_scopes_from_env`
- `access_policy.required_scopes_from_env`
- `access_policy.allowed_tool_categories_from_env`
- `access_policy.claim_mappings_from_env`

Formats and precedence:

- Scalar values use the raw env string.
- Array values use comma-separated strings.
- `claim_mappings_from_env` must be a JSON object with supported keys (`subject`, `email`, `groups`, `tenant_id`, `client_id`).
- Resolution precedence is `env value -> static profile value`.
- Empty env values are ignored and fall back to the static profile value.
- Invalid env-backed enterprise values fail profile loading instead of being ignored.

Runtime behavior:

- `mode: required` rejects arbitrary bearer tokens during MCP initialization and requires a trusted enterprise-issued token minted by the JWT bearer exchange.
- `mode: optional` keeps the existing bearer-token initialization path available for migration and mixed deployments.
- Enterprise tool-category policy applies to both `tools/list` filtering and runtime `tools/call` enforcement.

## Overview

OAuth 2.0 support enables browser-based authentication flow instead of manually managing API tokens:

- **Traditional**: Copy Personal Access Token → Paste into env var → Restart server
- **With OAuth**: Click "Connect" → Authorize in browser → Done

**Important**: OAuth is only available in **HTTP transport mode**. Stdio transport requires static tokens.

## Supported Flow

- **Authorization Code Flow with PKCE** (RFC 7636)
- Works with GitLab, GitHub, and any OAuth 2.0-compliant provider
- Secure: tokens handled by OAuth provider, not exposed in config files

## Setup: GitLab Example

### 1. Register OAuth Application in GitLab

1. Log into your GitLab instance (e.g., `https://www.gitlab.com`)
2. Go to **User Settings** → **Applications**
3. Click **Add new application**
4. Fill in:
   - **Name**: `MCP Server` (or any name)
   - **Redirect URI**: `http://<mcp-server-url:port>/oauth/callback`
     - Must match `redirect_uri` in your profile
     - Port must match `MCP4_PORT` environment variable
   - **Scopes**: Select required permissions:
     - `api` - Full API access
     - `read_user` - Read user profile
     - `read_repository` - Read repositories
5. Click **Save application**
6. **Copy** the generated **Application ID** and **Secret**

### 2. Configure Environment Variables (OS/User Profile)

Use OS-level user profile settings for environment variables. Do not use `~/.env.mcp`.

Linux/macOS (`~/.bashrc`, `~/.zshrc`, or your shell profile):

```bash
export MCP4_TRANSPORT=http
export MCP4_HOST=<mcp-server-url>
export MCP4_PORT=<mcp-server-port>
export MCP4_API_BASE_URL=https://www.gitlab.com/api/v4
export MCP4_OAUTH_ISSUER=https://www.gitlab.com
export MCP4_OAUTH_CLIENT_ID=your_application_id_here
export MCP4_OAUTH_CLIENT_SECRET=your_secret_here
export MCP4_OAUTH_REDIRECT_URI=http://<mcp-server-url>:<mcp-server-port>/oauth/callback
```

Windows PowerShell (`$PROFILE`):

```powershell
[Environment]::SetEnvironmentVariable("MCP4_TRANSPORT", "http", "User")
[Environment]::SetEnvironmentVariable("MCP4_HOST", "<mcp-server-url>", "User")
[Environment]::SetEnvironmentVariable("MCP4_PORT", "<mcp-server-port>", "User")
[Environment]::SetEnvironmentVariable("MCP4_API_BASE_URL", "https://www.gitlab.com/api/v4", "User")
[Environment]::SetEnvironmentVariable("MCP4_OAUTH_ISSUER", "https://www.gitlab.com", "User")
[Environment]::SetEnvironmentVariable("MCP4_OAUTH_CLIENT_ID", "your_application_id_here", "User")
[Environment]::SetEnvironmentVariable("MCP4_OAUTH_CLIENT_SECRET", "your_secret_here", "User")
[Environment]::SetEnvironmentVariable("MCP4_OAUTH_REDIRECT_URI", "http://<mcp-server-url>:<mcp-server-port>/oauth/callback", "User")
```

Optional for providers with non-standard OAuth paths:

```bash
export MCP4_OAUTH_AUTHORIZATION_URL=https://custom.example.com/auth/oauth2/authorize
export MCP4_OAUTH_TOKEN_URL=https://custom.example.com/auth/oauth2/token
```

Configuration priority:
1. Explicit URLs (`MCP4_OAUTH_AUTHORIZATION_URL`, `MCP4_OAUTH_TOKEN_URL`)
2. Explicit issuer (`MCP4_OAUTH_ISSUER`)
3. Autodiscovery from `MCP4_API_BASE_URL`

Complete environment variable reference: See [env.example](../env.example).

**Optional dynamic registration safety limits:**
- `MCP4_OAUTH_CLIENT_STORE_MAX_CLIENTS` (default: `1000`)
- `MCP4_OAUTH_CLIENT_STORE_MAX_REDIRECT_URIS` (default: `10`)
- `MCP4_OAUTH_CLIENT_STORE_MAX_REDIRECT_URI_LENGTH` (default: `256`)
- `MCP4_OAUTH_CLIENT_STORE_IDLE_GRACE_MS` (default: `0`)

Dynamic registration eviction policy:
- Idle dynamic clients are evicted first (`mcp-client-*`), while clients with active session usage or pending OAuth state/code are protected from eviction.
- If no idle candidate is safely evictable, dynamic registration returns `429` (`temporarily_unavailable`).

### 3. Use Built-In OAuth Profile

Use the bundled GitLab OAuth profile ID:

```bash
--profile gitlab
```

This avoids repository-specific profile paths and keeps client configuration portable.

### 4. Configure Cursor (Global User Profile)

Use global user configuration instead of repository-local `.cursor/mcp.json`.
OAuth requires HTTP transport and URL-based MCP server configuration. Do not use stdio `command`/`args` mode for OAuth.

Cursor user config path:
- Linux: `~/.config/Cursor/User/mcp.json`
- macOS: `~/Library/Application Support/Cursor/User/mcp.json`
- Windows: `%APPDATA%\Cursor\User\mcp.json`

Minimal Cursor config:

```json
{
  "mcpServers": {
    "gitlab-oauth": {
      "url": "http://<mcp-server-url>:<mcp-server-port>/mcp"
    }
  }
}
```

### 5. Start and Connect

Start the server in HTTP transport mode:

```bash
npx -y mcp4openapi --profile gitlab --transport http --host <mcp-server-url> --port <mcp-server-port>
```

1. Reload Cursor MCP servers.
2. Connect to `gitlab-oauth`.
3. Complete browser authorization.

For local verification outside Cursor:

```bash
npx -y mcp4openapi --profile gitlab --transport http
```

The server will log:

```
OAuth provider initialized
OAuth routes registered
MCP server running on HTTP <mcp-server-url>:<mcp-server-port>
```

## OAuth Endpoints

When OAuth is enabled, the following endpoints are available:

### Discovery Endpoints

- **`/.well-known/oauth-authorization-server`** - OAuth server metadata
- **`/.well-known/oauth-protected-resource/mcp`** - Protected resource metadata

When profile routing is enabled, you can select a profile with a `resource` query parameter:

```
/.well-known/oauth-protected-resource/mcp?resource=http://localhost:3003/profile/gitlab/mcp
```

### OAuth Flow Endpoints

- **`/oauth/authorize`** - Authorization endpoint (redirects to external OAuth provider)
- **`/oauth/token`** - Token exchange endpoint
- **`/oauth/revoke`** - Token revocation endpoint
- **`/oauth/register`** - Dynamic client registration (RFC 7591)

### MCP Endpoints

- **`POST /mcp`** - MCP requests (requires OAuth token)
- **`GET /mcp`** - SSE streaming (requires OAuth token)
- **`DELETE /mcp`** - Session termination

## Advanced Configuration

### Custom Resource Metadata

Override OAuth 2.0 Protected Resource metadata in your profile to provide custom name and documentation URL for the API:

```json
{
  "profile_name": "gitlab-production",
  "description": "GitLab API with OAuth 2.0 for production",
  "resource_name": "GitLab Production API",
  "resource_documentation": "https://docs.gitlab.com/ee/api/",
  "tools": [
    // ... your tools
  ]
}
```

**Defaults:**
- `resource_name`: Uses OpenAPI `info.title`, falls back to `"MCP Server"` if not available
- `resource_documentation`: Uses OpenAPI `externalDocs.url`, omitted if not available
- `scopes_supported`: Uses OAuth `scopes` from profile auth config, omitted if empty

These fields are optional and will be exposed in the `/.well-known/oauth-protected-resource/mcp` endpoint, helping OAuth clients display meaningful information about the protected resource.

### OAuth Rate Limiting Configuration

You can configure OAuth rate limiting directly in your profile file:

```json
{
  "profile_name": "gitlab-production",
  "interceptors": {
    "auth": {
      "type": "oauth",
      "oauth_config": {
        "issuer": "${env:MCP4_OAUTH_ISSUER}",
        "client_id": "${env:MCP4_OAUTH_CLIENT_ID}",
        "client_secret": "${env:MCP4_OAUTH_CLIENT_SECRET}",
        "scopes": ["api", "read_repository"]
      },
      "oauth_rate_limit": {
        "max_requests": 20,
        "window_ms": 900000
      }
    }
  }
}
```

**Configuration Priority**:
1. Profile `oauth_rate_limit` (highest priority)
2. Environment variables (`MCP4_OAUTH_RATE_LIMIT_MAX`, `MCP4_OAUTH_RATE_LIMIT_WINDOW_MS`)
3. Defaults (10 requests per 1 minute per IP)

**Recommendations**:
- **Development**: 10-20 requests per minute per IP
- **Production**: 10-15 requests per minute per IP
- **High-traffic**: Adjust based on your OAuth provider's rate limits

### SSL/TLS Support

For production deployments or when OAuth clients require HTTPS endpoints, you can enable SSL/TLS by providing certificate and key files:

```bash
# SSL Configuration
MCP4_SSL_CERT_FILE=/path/to/certificate.pem
MCP4_SSL_KEY_FILE=/path/to/private-key.pem
```

When both environment variables are set, the server automatically starts in HTTPS mode instead of HTTP. Update your redirect URI to use `https://` scheme:

```bash
MCP4_OAUTH_REDIRECT_URI=https://<mcp-server-url>:<mcp-server-port>/oauth/callback
```

**Certificate Requirements:**
- PEM format for both certificate and key
- Certificate must be valid and trusted by OAuth clients
- For development: self-signed certificates work but may require client configuration
- For production: use certificates from trusted CA (e.g., Let's Encrypt)

**Security Note**: Protect your private key file with appropriate file permissions (e.g., `chmod 600 private-key.pem`).

### Custom Redirect URI

If you need a different callback URL:

```json
{
  "auth": {
    "type": "oauth",
    "oauth_config": {
      "redirect_uri": "<schema>://<mcp-server-url:port>/callback",
      ...
    }
  }
}
```

**Important**: Update redirect URI in GitLab application settings to match. Native-app schemes (`cursor://…`, `vscode://…`) are supported - just add their host to `allowed_redirect_hosts` (or `MCP4_ALLOWED_ORIGINS`) so validation passes.

Allowed redirect hosts accept exact hostnames, wildcard subdomains (`*.example.com`), IPv4 addresses, IPv4 CIDR ranges (e.g., `10.0.0.0/8`), and IPv6 addresses/CIDR ranges (e.g., `2001:db8::/32`) so you can allow whole internal networks without listing individual machines.

### Unregistered OAuth clients for multi-pod deployments

When multiple pods or clusters share the same OAuth authorization surface, the authorize request can land on an instance that does not have the requesting `client_id` registered locally yet. You can allow that authorize request to continue, but only for explicitly approved redirect URI patterns.

```json
{
  "oauth_config": {
    "allow_unregistered_clients": true,
    "allowed_unregistered_redirect_uris": [
      "http://localhost",
      "http://127.0.0.1",
      "cursor://",
      "cursor://anysphere.cursor-mcp"
    ]
  }
}
```

Rules:

- Disabled by default.
- Only `authorize` requests are relaxed; the client is materialized locally only after its `redirect_uri` matches an approved rule.
- Loopback approvals such as `http://localhost` and `http://127.0.0.1` allow dynamic callback ports.
- Scheme-only custom URI approvals such as `cursor://` allow any host for that scheme.
- Exact custom URI approvals such as `cursor://anysphere.cursor-mcp` restrict callbacks to that host only.
- Invalid, dangerous, or confusing redirects (for example `javascript:`, `localhost.evil.test`, or `localhost@evil.test`) are rejected.

This is intended as phase 1 compatibility for shared or failover deployments. It does not yet share pending OAuth state, authorization codes, or tokens across pods - use a shared backend such as Redis for that in a later phase.

### Additional OAuth Endpoints

Optional endpoints for advanced features:

```json
{
  "oauth_config": {
    ...
    "introspection_endpoint": "https://www.gitlab.com/oauth/introspect",
    "revocation_endpoint": "https://www.gitlab.com/oauth/revoke",
    "registration_endpoint": "https://www.gitlab.com/oauth/register"
  }
}
```

### Multiple Scopes

Request specific permissions:

```json
{
  "oauth_config": {
    "scopes": ["api", "read_repository"]
  }
}
```

**GitLab Scopes:**
- `api` - Full API access
- `read_user` - Read user profile
- `read_api` - Read-only API access
- `read_repository` - Read repositories
- `write_repository` - Write repositories
- `read_registry` - Read container registry
- `write_registry` - Write container registry
- `sudo` - Perform API actions as any user (admin only)

See [GitLab OAuth documentation](https://docs.gitlab.com/ee/api/oauth2.html) for full scope list.

## Troubleshooting

### "Redirect URI mismatch"

**Cause**: Redirect URI in profile doesn't match GitLab application settings.

**Fix**:
1. Check `redirect_uri` in your profile
2. Ensure it matches exactly in GitLab application settings
3. Port must match `MCP4_PORT` environment variable

### "Client authentication failed"

**Cause**: Invalid `client_id` or `client_secret`.

**Fix**:
1. Verify Application ID and Secret from GitLab
2. Check environment variables are set correctly
3. Ensure no extra spaces or quotes in env var values

### "Authorization failed: insufficient scopes"

**Cause**: Requested scopes not granted in GitLab application.

**Fix**:
1. Edit GitLab application
2. Enable required scopes
3. Re-authorize in browser

### Browser doesn't open

**Cause**: MCP client doesn't support OAuth or browser not accessible.

**Fix**:
- OAuth requires HTTP transport mode
- Ensure browser is accessible from the host running MCP server
- Check MCP client logs for OAuth redirect URL
- Manually open the authorization URL in browser

### "OAuth authentication not supported in InterceptorChain"

**Cause**: Trying to use OAuth in stdio transport mode.

**Fix**: OAuth only works in HTTP transport. Set `MCP4_TRANSPORT=http` in environment.

## Security Best Practices

### 1. Protect Client Secret

- Never commit to version control
- Use environment variables or secret managers
- Rotate secrets periodically

### 2. Limit Scopes

Request only necessary permissions:

```json
{
  "scopes": ["read_api", "read_repository"]  // Read-only
}
```

### 3. Use HTTPS in Production

For production deployments:

```json
{
  "oauth_config": {
    "redirect_uri": "https://mcp.example.com/oauth/callback"
  }
}
```

### 4. Configure Allowed Origins

Prevent CSRF attacks and open redirect vulnerabilities:

```bash
export MCP4_ALLOWED_ORIGINS="https://cursor.com,https://your-client.com"
```

**OAuth Redirect URI Validation**: When OAuth is enabled, redirect URIs are validated against `MCP4_ALLOWED_ORIGINS`. The redirect host must match one of:
- Exact hostname (e.g., `example.com`)
- Wildcard pattern (e.g., `*.company.com` matches `app.company.com`)
- `localhost` or `127.0.0.1` (always allowed for local development)

**Example**: If `MCP4_ALLOWED_ORIGINS=https://app.example.com,*.company.com`, valid redirect URIs include:
- `http://localhost:3003/oauth/callback` ✅ (localhost always allowed)
- `https://app.example.com/oauth/callback` ✅ (exact match)
- `https://dev.company.com/oauth/callback` ✅ (wildcard match)
- `https://evil.com/oauth/callback` ❌ (rejected - not in allowlist)

### 5. Configure Rate Limiting

Rate limiting is enabled by default. OAuth endpoints have stricter limits for security:

**General HTTP Rate Limiting:**
```bash
export MCP4_HTTP_RATE_LIMIT_ENABLED=true
export MCP4_HTTP_RATE_LIMIT_MAX_REQUESTS=100  # requests per minute
export MCP4_HTTP_RATE_LIMIT_WINDOW_MS=60000   # 1 minute window
```

**OAuth Rate Limiting** (stricter limits for `/oauth/authorize`, `/oauth/token`, `/oauth/callback`):
```bash
export MCP4_OAUTH_RATE_LIMIT_MAX=10           # Max OAuth requests per window (default: 10)
export MCP4_OAUTH_RATE_LIMIT_WINDOW_MS=60000   # OAuth rate limit window (default: 1 minute)
```

**Configuration Priority**: Profile > Environment variables > Defaults

**Defaults**:
- General endpoints: 100 requests/minute
- OAuth endpoints: 10 requests/1 minute
```

## Token Lifetime & Auto-Refresh

OAuth access tokens are short-lived (typically 15-60 minutes) for security reasons. The MCP server automatically handles token refresh using refresh tokens, so you don't need to manually restart MCP in your IDE when tokens expire.

**How it works:**

1. **Initial OAuth Flow**: When you authorize via OAuth, the server receives both an access token and a refresh token
2. **Token Storage**: The refresh token is securely stored in the session (not exposed to the client)
3. **Automatic Refresh**: Before making API calls, the server checks if the access token is expired or about to expire
4. **Transparent Renewal**: If needed, the server automatically exchanges the refresh token for a new access token
5. **Extended Session Lifetime**: OAuth sessions with refresh tokens have extended timeouts (24 hours by default) to avoid forcing re-authentication after periods of inactivity

**Benefits:**

- **No manual intervention**: Tokens refresh automatically without user action
- **No IDE restarts**: MCP remains functional even after token expiration
- **Better security**: Short-lived access tokens with long-lived refresh tokens
- **Seamless experience**: Users don't see authentication errors or need to re-authorize frequently

**Configuration:**

You can configure the refresh threshold and session timeout via environment variables:

```bash
# Refresh token 60 seconds before expiration (default)
MCP4_OAUTH_REFRESH_THRESHOLD_MS=60000

# OAuth session timeout: 24 hours (default), 0 = unlimited
MCP4_OAUTH_SESSION_TIMEOUT_MS=86400000
```

**Note**: If a refresh token is revoked or invalid, you'll need to re-authorize via OAuth flow. This is rare and typically only happens when you explicitly revoke access in your OAuth provider's settings.

## Comparison: OAuth vs Static Token

| Feature | Static Token | OAuth |
|---------|-------------|-------|
| Setup Complexity | Low (copy/paste) | Medium (OAuth app registration) |
| User Experience | Manual token management | Browser-based authorization |
| Token Expiration | Manual refresh required | **Automatic refresh** |
| Session Lifetime | 30 minutes inactivity | **24 hours (configurable)** |
| Revocation | Revoke in GitLab | Revoke via API or GitLab |
| Security | Token in env var | Token managed by OAuth provider |
| Transport Support | stdio + HTTP | **HTTP only** |

## Next Steps

- **GitHub OAuth**: Similar setup with GitHub OAuth apps
- **Custom OAuth Provider**: Adapt for your OAuth 2.0 provider
- **Auto-detection from OpenAPI**: Future enhancement to detect OAuth from `securitySchemes`

## References

- [OAuth 2.0 RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749)
- [PKCE RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)
- [GitLab OAuth2 Documentation](https://docs.gitlab.com/ee/api/oauth2.html)
- [MCP Authentication Specification](https://modelcontextprotocol.io)
