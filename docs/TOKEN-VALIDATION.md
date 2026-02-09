# Token Validation Guide

## Overview

Token validation allows the MCP server to verify authentication tokens during initialization, providing immediate feedback if a token is invalid or expired.

## Why Token Validation?

**Without validation:**
- ❌ Server connects successfully (shows "26 tools detected")
- ❌ First tool call fails with 401
- ❌ User thinks they're connected but aren't
- ❌ Confusion about where the problem is

**With validation:**
- ✅ Server rejects connection immediately with 401
- ✅ Clear error message: "Invalid or expired token"
- ✅ User knows to fix the token right away
- ✅ Better UX, especially for CI/CD

## GitLab API Configuration Example

Add `validation_endpoint` to your auth configuration:

### GitLab with read_api Scope

```json
{
  "interceptors": {
    "auth": {
      "type": "bearer",
      "value_from_env": "MCP4_API_TOKEN",
      "validation_endpoint": "/api/v4/personal_access_tokens/self",
      "validation_timeout_ms": 3000
    },
    "base_url": {
      "value_from_env": "MCP4_API_BASE_URL",
      "default": "https://gitlab.com/api/v4"
    }
  }
}
```

**Environment variables:**
```bash
# Token for authentication
export MCP4_API_TOKEN=glpat-xxxxxxxxxxxx

# GitLab instance URL (optional, defaults to gitlab.com)
export MCP4_API_BASE_URL=https://gitlab.example.com/api/v4
```

CLI alternative:
```bash
npx mcp4openapi \
  --api-token glpat-xxxxxxxxxxxx \
  --api-base-url https://gitlab.example.com/api/v4
```

### Multi-Auth with Validation

```json
{
  "interceptors": {
    "auth": [
      {
        "type": "oauth",
        "priority": 0,
        "oauth_config": {...}
      },
      {
        "type": "bearer",
        "priority": 1,
        "value_from_env": "MCP4_API_TOKEN",
        "validation_endpoint": "/api/v4/personal_access_tokens/sel"
      }
    ],
    "base_url": {
      "value_from_env": "MCP4_API_BASE_URL",
      "default": "https://gitlab.com/api/v4"
    }
  }
}
```

**Environment variables:**
```bash
# OAuth credentials (for interactive users)
export MCP4_OAUTH_AUTHORIZATION_URL=https://gitlab.example.com/oauth/authorize
export MCP4_OAUTH_TOKEN_URL=https://gitlab.example.com/oauth/token
export MCP4_OAUTH_CLIENT_ID=xxx
export MCP4_OAUTH_CLIENT_SECRET=yyy
export MCP4_OAUTH_REDIRECT_URI=https://mcp-gitlab.example.com/oauth/callback

# Bearer token (for CI/CD)
export MCP4_API_TOKEN=glpat-xxxxxxxxxxxx

# GitLab instance URL
export MCP4_API_BASE_URL=https://gitlab.example.com/api/v4
```

CLI alternative:
```bash
npx mcp4openapi \
  --oauth-authorization-url https://gitlab.example.com/oauth/authorize \
  --oauth-token-url https://gitlab.example.com/oauth/token \
  --oauth-client-id xxx \
  --oauth-client-secret yyy \
  --oauth-redirect-uri https://mcp-gitlab.example.com/oauth/callback \
  --api-token glpat-xxxxxxxxxxxx \
  --api-base-url https://gitlab.example.com/api/v4
```

**How it works:**
- OAuth tokens are validated via OAuth flow
- Bearer tokens are validated via `validation_endpoint`
- Both use the same `base_url` from environment variable

### Parameters

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `validation_endpoint` | `string` | No | - | API endpoint to validate token |
| `validation_method` | `string` | No | `GET` | HTTP method (`GET` or `HEAD`) |
| `validation_timeout_ms` | `number` | No | `5000` | Timeout in milliseconds |
| `validation_allowed_hosts` | `string[]` | No | - | Additional hosts allowed for absolute `validation_endpoint` URLs |

By default, absolute `validation_endpoint` must match `base_url` origin. Use `validation_allowed_hosts` only when validation must call a different trusted host.

### GitLab API Endpoint `/api/v4/personal_access_tokens/self`:

**Pros:**
- ✅ Purpose-built for token validation
- ✅ Returns token info (scopes, expiry, active status)
- ✅ Works with **any scope** including `read_api`
- ✅ Lightweight and fast
- ✅ Clear 401 for invalid tokens

**Response (valid token):**
```json
{
  "id": 123,
  "name": "my-token",
  "active": true,
  "scopes": ["read_api"],
  "expires_at": "2025-12-31"
}
```

## Other API Provider Examples

### GitHub

```json
{
  "validation_endpoint": "/user"
}
```

Works with all token types (PAT, OAuth).

### YouTrack

```json
{
  "validation_endpoint": "/api/users/me"
}
```

Validates permanent token and returns current user.

### Generic REST API

For APIs without a dedicated introspection endpoint:

```json
{
  "validation_endpoint": "/health",
  "validation_method": "HEAD"
}
```

Or use any lightweight `GET` endpoint that requires authentication.

## Validation Behavior

### Success (200-299)

Token is valid → session is created → tools are available

```
POST /mcp (initialize)
Authorization: Bearer valid_token

→ 200 OK
→ Mcp-Session-Id: abc-123
→ Tools available
```

### Failure (401)

Token is invalid → connection rejected → user sees error

```
POST /mcp (initialize)
Authorization: Bearer invalid_token

→ 401 Unauthorized
{
  "error": "Unauthorized",
  "message": "Invalid or expired authentication token"
}
```

### Timeout

If validation takes longer than `validation_timeout_ms`:

```
→ 401 Unauthorized
{
  "error": "Unauthorized",
  "message": "Invalid or expired authentication token"
}
```

### No Validation Endpoint

If `validation_endpoint` is not configured:

```
→ Session created without validation
→ Token validated on first tool call (lazy validation)
```

## Security Considerations

### 1. Rate Limiting

Validation happens on **every initialization**:
- New connection = 1 validation request
- Reconnect after timeout = 1 validation request

**Impact:** If you have many clients or frequent reconnects, this adds API calls.

**Mitigation:**
- Use lightweight endpoints (`/personal_access_tokens/self`)
- Configure appropriate `validation_timeout_ms`
- Consider caching at API gateway level (not implemented in MCP server)

### 2. Token Exposure

Validation requests send the token to the API:
- ✅ Same as any authenticated request
- ✅ HTTPS recommended (default for GitLab, GitHub)
- ❌ Never log tokens in validation failures

## Performance

### Overhead

| Scenario | Validation Time | Impact |
|----------|----------------|---------|
| Fast API (< 100ms) | ~100ms | Negligible |
| Slow API (500ms) | ~500ms | Noticeable delay |
| Timeout (5000ms) | 5000ms | Bad UX |

**Recommendation:** Set `validation_timeout_ms` to match your API's typical latency + buffer:
- Fast API: 500-2000ms
- Slow API: 2000-10000ms

### Optimization

Use `HEAD` method when possible:

```json
{
  "validation_method": "HEAD"
}
```

**Pros:**
- No response body (faster)
- Less bandwidth

**Cons:**
- Some APIs don't support `HEAD`
- May not validate token properly (some APIs return 200 for `HEAD` even without auth)

## Troubleshooting

### Validation Always Fails

**Symptom:** Can't connect even with valid token

**Causes:**
1. Wrong endpoint (returns 404)
2. Insufficient scope (returns 403)
3. Network issues (timeout)

**Solution:**
```bash
# Test endpoint manually
curl -H "Authorization: Bearer $TOKEN" \
  https://gitlab.com/api/v4/personal_access_tokens/self

# Check response
# 200 = endpoint works
# 401 = token invalid
# 403 = insufficient scope
# 404 = wrong endpoint
```

### Validation Too Slow

**Symptom:** Initialization takes 5+ seconds

**Cause:** API is slow or validation timeout is too high

**Solution:**
1. Reduce timeout:
```json
{
  "validation_timeout_ms": 2000
}
```

2. Use faster endpoint:
```json
{
  "validation_endpoint": "/api/v4/projects?per_page=1"
}
```

### Validation Succeeds but Tools Fail

**Symptom:** Connection works, but tool calls return 401

**Cause:** Validation endpoint doesn't require the same scope as tools

**Example:**
- Validation: `/api/v4/projects` (works with `read_api`)
- Tool: Create issue (requires `api` scope)

**Solution:** Ensure token has required scopes for actual operations, not just validation.

## Best Practices

1. **Always set validation_endpoint for Bearer tokens in production**
   - Fail fast on invalid tokens
   - Better error messages for users

2. **Choose lightweight endpoints**
   - Prefer `/personal_access_tokens/self` over `/user`
   - Add `per_page=1` to list endpoints

3. **Set appropriate timeout**
   - Fast APIs: 500-2000ms
   - Slow APIs: 5000ms
   - Very slow/unreliable: Consider not using validation

4. **Test your validation endpoint**
   ```bash
   # Valid token
   curl -H "Authorization: Bearer $VALID_TOKEN" $ENDPOINT
   # Should return 200

   # Invalid token
   curl -H "Authorization: Bearer invalid" $ENDPOINT
   # Should return 401
   ```

5. **Document required scopes**
   - If validation needs `read_api`, document it
   - If tools need `api`, document it
   - Make sure users know what scope to use

## Related Documentation

- [OAuth Guide](./OAUTH.md)
- [Multi-Auth Guide](./MULTI-AUTH.md)
- [Profile Guide](./PROFILE-GUIDE.md)
