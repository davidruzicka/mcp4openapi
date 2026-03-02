# Multi-Auth Support

Multi-auth allows a single MCP server to support multiple authentication methods simultaneously, with automatic fallback based on priority.

## Use Cases

### 1. OAuth for Users + Bearer for CI/CD

**Scenario**: Interactive users use OAuth flow in Cursor/VS Code, while CI/CD pipelines use static Bearer tokens.

**Profile Configuration**:

```json
{
  "interceptors": {
    "auth": [
      {
        "type": "oauth",
        "priority": 0,
        "oauth_config": {
          "issuer": "https://gitlab.example.com",
          "client_id": "${env:MCP4_OAUTH_CLIENT_ID}",
          "client_secret": "${env:MCP4_OAUTH_CLIENT_SECRET}",
          "redirect_uri": "${env:MCP4_OAUTH_REDIRECT_URI}"
        }
      },
      {
        "type": "bearer",
        "priority": 1,
        "value_from_env": "MCP4_API_TOKEN"
      }
    ]
  }
}
```

**How it works**:

1. **Interactive users** (Cursor/VS Code):
   - Server detects OAuth session
   - Uses OAuth token from session
   - If no session → displays "Connect" button

2. **CI/CD pipelines**:
   - Send `Authorization: Bearer <CI_TOKEN>` header
   - Server uses Bearer token
   - No browser flow required

---

### 2. Custom Header + Bearer Fallback

**Scenario**: Support legacy systems using custom headers (e.g., `X-API-Key`), while also supporting modern clients using standard Bearer tokens.

**Profile Configuration**:

```json
{
  "interceptors": {
    "auth": [
      {
        "type": "custom-header",
        "priority": 0,
        "header_name": "X-API-Key",
        "value_from_env": "API_KEY"
      },
      {
        "type": "bearer",
        "priority": 1,
        "value_from_env": "MCP4_API_TOKEN"
      }
    ]
  }
}
```

**How it works**:
- **Legacy client**: Sends `X-API-Key: abc123` → server uses custom header token
- **Modern client**: Sends `Authorization: Bearer xyz789` → server uses Bearer token
- Different clients can use different auth methods

---

## How Multi-Auth Works

### Authentication Flow

```
1. HTTP Transport receives request
   ↓
2. extractAuthToken() checks for authentication in order:
   a. OAuth session (mcp-session-id header)
   b. Authorization: Bearer header
   c. X-API-Token header (custom)
   ↓
3. If token found → authenticate request
   If no token → return 401 Unauthorized
```

### Priority Handling

- **Lower priority = Higher precedence**
- Priority `0` is tried first, then `1`, then `2`, etc.
- Default priority is `0` if not specified

**Example**:

```json
{
  "auth": [
    {"type": "oauth", "priority": 0},      // Tried first
    {"type": "bearer", "priority": 1},     // Tried second
    {"type": "custom-header", "priority": 2}  // Tried third
  ]
}
```

### Token Detection Logic

HTTP Transport checks for tokens in this order:

1. **OAuth Session**
   - Highest priority for active user sessions
   - If session exists and has token → use it

2. **Authorization Header** (Bearer token)
   - Format: `Authorization: Bearer <token>`
   - For CI/CD, API clients, scripts

3. **Custom Headers** (e.g., `X-API-Token`)
   - For legacy systems or special integrations

**Important**: Token detection happens in HTTP transport layer, **before** profile auth configs are consulted. Profile configs define which tokens are *valid* and how to use them, but detection is built into the transport.

---

## Configuration Reference

### Auth Array

```json
{
  "interceptors": {
    "auth": [
      {
        "type": "oauth | bearer | query | custom-header",
        "priority": 0,
        // ... type-specific fields
      }
    ]
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `string` | ✅ | Auth method: `oauth`, `bearer`, `query`, `custom-header` |
| `priority` | `integer` | ❌ | Priority (lower = higher). Default: `0` |
| `value_from_env` | `string` | ✅* | Environment variable name (for `bearer`, `query`, `custom-header`) |
| `header_name` | `string` | ✅** | Custom header name (for `custom-header`) |
| `query_param` | `string` | ✅*** | Query parameter name (for `query`) |
| `oauth_config` | `object` | ✅**** | OAuth configuration (for `oauth`) |

*Required for: `bearer`, `query`, `custom-header`  
**Required for: `custom-header`  
***Required for: `query`  
****Required for: `oauth`

---

## Single Auth Config Support

```json
{
  "interceptors": {
    "auth": {
      "type": "bearer",
      "value_from_env": "MCP4_API_TOKEN"
    }
  }
}
```

This is equivalent to:

```json
{
  "interceptors": {
    "auth": [
      {
        "type": "bearer",
        "priority": 0,
        "value_from_env": "MCP4_API_TOKEN"
      }
    ]
  }
}
```

---

## Security Considerations

### 1. Token Precedence

- OAuth sessions take precedence over static tokens
- Prevents accidental use of wrong credentials
- User-specific OAuth tokens > service account tokens

### 2. Environment Variables

- **Never** commit tokens to version control
- Use `.env` files locally (gitignored)
- Use Kubernetes Secrets in production

**Example `.env`**:

```bash
# Required for OAuth browser flow
MCP4_TRANSPORT=http

# OAuth (for interactive users)
MCP4_OAUTH_CLIENT_ID=your-client-id
MCP4_OAUTH_CLIENT_SECRET=your-secret

# Bearer (for CI/CD)
MCP4_API_TOKEN=glpat-xxxxxxxxxxxx

# GitLab instance URL
MCP4_API_BASE_URL=https://gitlab.example.com/api/v4
```

CLI alternative:
```bash
npx mcp4openapi \
  --transport http \
  --oauth-client-id your-client-id \
  --oauth-client-secret your-secret \
  --api-token glpat-xxxxxxxxxxxx \
  --api-base-url https://gitlab.example.com/api/v4
```

### 3. Token Rotation

- OAuth tokens: Automatically refreshed by OAuth provider
- Bearer tokens: Rotate manually or use short-lived CI tokens

---

## Testing Multi-Auth

### Test 1: OAuth (Interactive User)

```bash
# 1. Start server with multi-auth profile
export MCP4_TRANSPORT=http
export MCP4_OAUTH_AUTHORIZATION_URL=https://gitlab.example.com/oauth/authorize
export MCP4_OAUTH_TOKEN_URL=https://gitlab.example.com/oauth/token
export MCP4_OAUTH_CLIENT_ID=xxx
export MCP4_OAUTH_CLIENT_SECRET=yyy
export MCP4_OAUTH_REDIRECT_URI=https://<your-mcp-server-host>/oauth/callback
export MCP4_API_BASE_URL=https://gitlab.example.com/api/v4
npm start

# 2. Configure Cursor
{
  "mcpServers": {
    "gitlab": {
      "url": "http://<your-mcp-server-host>/mcp"
    }
  }
}

# 3. Click "Connect" button → OAuth flow
```

CLI alternative:
```bash
npx mcp4openapi \
  --transport http \
  --oauth-authorization-url https://gitlab.example.com/oauth/authorize \
  --oauth-token-url https://gitlab.example.com/oauth/token \
  --oauth-client-id xxx \
  --oauth-client-secret yyy \
  --oauth-redirect-uri https://<your-mcp-server-host>/oauth/callback \
  --api-base-url https://gitlab.example.com/api/v4
```

### Test 2: Bearer Token (CI/CD)

```bash
# Without OAuth session, use Bearer token
curl -H "Authorization: Bearer $MCP4_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
     http://localhost:3003/mcp
```

### Test 3: Verify Priority

```bash
# Create session with OAuth
curl -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
     http://localhost:3003/mcp

# Extract session ID from response
# Then try with both OAuth session AND Bearer token
# OAuth should take precedence

curl -H "Mcp-Session-Id: <session-id>" \
     -H "Authorization: Bearer $MCP4_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
     http://localhost:3003/mcp

# Should use OAuth token from session, not Bearer token
```

---

## Troubleshooting

### Issue: Both OAuth and Bearer configured, but only Bearer works

**Cause**: OAuth endpoints not initialized (missing OAuth config or environment variables)

**Solution**:
```bash
# Check server logs
grep -i "oauth" server.log

# Should see:
# "OAuth authentication enabled for HTTP transport"
# "OAuth provider initialized"
# "OAuth routes registered"

# If missing, verify:
echo $MCP4_OAUTH_CLIENT_ID
echo $MCP4_OAUTH_CLIENT_SECRET
```

### Issue: CI/CD pipeline fails with 401

**Cause**: Bearer token not provided or invalid

**Solution**:
```bash
# Verify token in environment
echo $MCP4_API_TOKEN

# Test token manually
curl -H "Authorization: Bearer $MCP4_API_TOKEN" \
     https://www.gitlab.com/api/v4/personal_access_tokens/self
```

### Issue: "Connect" button not showing in Cursor

**Cause**: OAuth metadata endpoint not available

**Solution**:
```bash
# Verify OAuth metadata
curl http://localhost:3003/.well-known/oauth-authorization-server

# Should return JSON with OAuth endpoints
# If 404, OAuth is not initialized
```

---

## Examples

### Example 1: GitLab Multi-Auth

See: [`profiles/gitlab/multi-auth-profile.json`](../profiles/gitlab/multi-auth-profile.json)

### Example 2: Production Deployment

```yaml
# K8s deployment with multi-auth
apiVersion: v1
kind: Secret
metadata:
  name: mcp-gitlab-auth
data:
  oauth-client-id: <base64>
  oauth-client-secret: <base64>
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-gitlab
spec:
  template:
    spec:
      containers:
      - name: mcp-server
        env:
        # OAuth for users
        - name: MCP4_OAUTH_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: mcp-gitlab-auth
              key: oauth-client-id
        - name: MCP4_OAUTH_CLIENT_SECRET
          valueFrom:
            secretKeyRef:
              name: mcp-gitlab-auth
              key: oauth-client-secret
        # Bearer token sent in Authorization header from client
```

---

## Best Practices

1. **Use OAuth for Interactive Users**
   - Better UX (browser-based auth)
   - Automatic token refresh
   - User-specific permissions

2. **Use Bearer for Automation**
   - CI/CD pipelines
   - Scheduled jobs
   - Service-to-service calls

3. **Set Priorities Correctly**
   - OAuth (priority 0) for users
   - Bearer (priority 1) for automation
   - Custom fallbacks (priority 2+)

4. **Secure Environment Variables**
   - Use Kubernetes Secrets
   - Never log tokens
   - Rotate regularly

5. **Test Both Paths**
   - Verify OAuth flow works
   - Verify Bearer token works
   - Test fallback behavior

---

## Related Documentation

- [OAuth Setup Guide](./OAUTH.md)
- [Kubernetes Deployment](./DEPLOYMENT-K8S-OAUTH.md)
- [Profile Guide](./PROFILE-GUIDE.md)
- [HTTP Transport](./HTTP-TRANSPORT.md)
