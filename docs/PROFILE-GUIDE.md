# Profile Creation Guide

This guide explains how to create custom MCP tool profiles for any OpenAPI-compliant API.

## Quick Start

1. **Create empty profile**:
   ```bash
   touch profiles/<my-api-name>-profile.json
   ```

2. **Add JSON Schema reference** (for IDE auto-complete and validation):
   ```json
   {
     "$schema": "../profile-schema.json",
     "profile_name": "<my-api-name>"
   }
   ```

3. **Define your tools** (see sections below)

4. **Validate** (no API access required):
   ```bash
   # Validate profile structure only
   npm run validate -- profiles/<my-api-name>-profile.json
   
   # Validate profile + check operations exist in OpenAPI spec
   npm run validate -- profiles/<my-api-name>-profile.json path/to/openapi.yaml
   ```

5. **Test with real API**:
   ```bash
   npm run build
   export MCP4_OPENAPI_SPEC_PATH=./path/to/openapi.yaml
   export MCP4_PROFILE_PATH=./profiles/<my-api-name>-profile.json
   npm start
   ```

## Profile Structure

```json
{
  "$schema": "../profile-schema.json",
  "profile_name": "unique-name",
  "description": "What this profile provides",
  "parameter_aliases": { ... },
  "resource_name": "My API",
  "resource_documentation": "https://docs.example.com/api",
  "tools": [ ... ],
  "interceptors": { ... }
}
```

### Fields

- **`$schema`** (optional): Path to `profile-schema.json` for IDE validation
- **`profile_name`** (required): Unique identifier (lowercase, underscores)
- **`description`** (optional): Human-readable description
- **`parameter_aliases`** (optional): Map parameter names to common aliases
- **`resource_name`** (optional): OAuth 2.0 resource name (overrides OpenAPI `info.title`, defaults to `"MCP Server"`)
- **`resource_documentation`** (optional): OAuth 2.0 resource documentation URL (overrides OpenAPI `externalDocs.url`)
- **`tools`** (required): Array of tool definitions
- **`interceptors`** (optional): Auth, rate limiting, retry configuration

#### OAuth Resource Metadata

The `resource_name` and `resource_documentation` fields are used in OAuth 2.0 Protected Resource Metadata (RFC 8707) when HTTP transport with OAuth is enabled:

- **`resource_name`**: Human-readable name of the API displayed to OAuth clients (e.g., "GitLab Production API")
  - Priority: Profile > OpenAPI `info.title` > `"MCP Server"` (fallback)
- **`resource_documentation`**: URL to API documentation for OAuth clients (e.g., "https://docs.gitlab.com/ee/api/")
  - Priority: Profile > OpenAPI `externalDocs.url` > omitted if not available

These fields are exposed in the `/.well-known/oauth-protected-resource/mcp` endpoint and help OAuth clients (like Cursor) display meaningful information about the protected resource. See [OAuth Configuration Guide](./OAUTH.md) for details.

## Tool Types

### 1. Simple Tool (Action-based)

Maps user actions to OpenAPI operations.

**Example: CRUD operations**

```json
{
  "name": "manage_users",
  "description": "Manage users: list, get, create, update, delete",
  "operations": {
    "list": "getUsers",
    "get": "getUserById",
    "create": "postUsers",
    "update": "putUsersId",
    "delete": "deleteUsersId"
  },
  "parameters": {
    "action": {
      "type": "string",
      "enum": ["list", "get", "create", "update", "delete"],
      "description": "Action to perform",
      "required": true
    },
    "id": {
      "type": "string",
      "description": "User ID",
      "required_for": ["get", "update", "delete"]
    },
    "name": {
      "type": "string",
      "description": "User name",
      "required_for": ["create"]
    },
    "email": {
      "type": "string",
      "description": "User email",
      "required_for": ["create"]
    }
  }
}
```

**Key points**:
- `operations`: Maps each action to an OpenAPI `operationId`
- `action` parameter: Enum of available actions
- `required_for`: Conditional parameter requirements

### 2. Composite Tool (Multi-step)

Chains multiple API calls and returns aggregated results.

**Example: Fetch resource with related data**

```json
{
  "name": "get_issue_with_details",
  "description": "Get issue with comments, attachments, and history",
  "composite": true,
  "partial_results": true,
  "steps": [
    {
      "call": "getIssuesId",
      "store_as": "issue"
    },
    {
      "call": "getIssuesIdComments",
      "store_as": "issue.comments"
    },
    {
      "call": "getIssuesIdAttachments",
      "store_as": "issue.attachments"
    }
  ],
  "parameters": {
    "id": {
      "type": "string",
      "description": "Issue ID",
      "required": true
    }
  }
}
```

**Key points**:
- `composite: true`: Enables multi-step execution
- `partial_results: true`: Can return partial data even if some steps fail
- `steps`: Array of API calls with result storage paths
- `store_as`: JSON path where to store result (e.g., `issue.comments`)
- **Parameter aliases**: Composite tools automatically use `parameter_aliases` from profile to map parameters in `call` steps. For example, if your tool accepts `project_id` but the OpenAPI path uses `{id}`, the alias mapping will resolve it correctly.

### 3. Proxy download tool

Use `proxy_download` operations when an API returns a URL for binary content that still requires authentication (e.g., attachment downloads). The server fetches metadata, validates limits, downloads the file, and returns base64 content.

**Example: proxying an attachment download**

```json
{
  "name": "download_issue_attachment",
  "description": "Download an issue attachment with validation",
  "operations": {
    "download_issue_attachment": {
      "type": "proxy_download",
      "metadata_endpoint": "get_/issues/{id}/attachments/{attachmentId}",
      "url_field": "url",
      "skip_auth": true,
      "max_size_bytes": 10485760,
      "max_size_bytes_from_env": "MYAPP_PROXY_MAX_BYTES"
    }
  }
}
```

**Key fields**

- `metadata_endpoint` (required): Operation ID that returns the URL to download.
- `url_field` (optional): Dot-notation path to the URL inside the metadata response (default: `"url"`).
- `max_size_bytes` (optional): Download size limit in bytes (default: 10 MB).
- `max_size_bytes_from_env` (optional): Environment variable name that overrides `max_size_bytes` (e.g., `CUSTOM_PROXY_MAX_BYTES`).
- `timeout_ms` (optional): Download timeout in milliseconds (default: 30000).
- `allowed_mime_types` (optional): Whitelist of allowed MIME types (supports wildcards such as `image/*`).
- `skip_auth` (optional): When `true`, skips auth for the final download URL (useful for pre-signed links). **If the extracted download URL is cross-origin (different origin than your API base URL), `skip_auth` must be `true` to avoid leaking credentials.**
- `allowed_hosts` (optional): Allowlist for cross-origin downloads when `skip_auth: true` (recommended). Supports exact hosts like `cdn.example.com` and wildcard subdomains like `*.example.com`.
- `allow_private_network` (optional): SSRF safety switch. When `true` and `skip_auth: true`, allows cross-origin downloads for `localhost` and private/loopback/link-local IPs (including hostnames that resolve to them). Default is `false`.

**Download size precedence**

`max_size_bytes_from_env` → `MCP4_PROXY_MAX_BYTES` → `max_size_bytes` → default (10 MB). Invalid env values raise a `ValidationError`.

## Parameters

### Basic Parameter

```json
{
  "name": {
    "type": "string",
    "description": "Clear description for LLM",
    "required": true
  }
}
```

### Parameter Types

- `string`: Text value
- `integer`: Whole number
- `number`: Decimal number
- `boolean`: true/false
- `array`: List of values
- `object`: Nested structure

Array a object parametry se nyní validují i na úrovni generovaného JSON Schématu: `validate-profile` zkontroluje `items`/`properties` a vygenerované schéma zohlední požadovaná pole i vnořené struktury. Díky tomu IDE lépe napovídá a klienti mají přesnější kontrakty.

### Advanced Features

#### Conditional Requirements

```json
{
  "badge_id": {
    "type": "string",
    "description": "Badge ID",
    "required_for": ["get", "update", "delete"]
  }
}
```

#### Enums

```json
{
  "status": {
    "type": "string",
    "enum": ["open", "closed", "pending"],
    "description": "Issue status"
  }
}
```

#### Arrays

```json
{
  "tags": {
    "type": "array",
    "items": { "type": "string" },
    "description": "List of tags"
  }
}
```

#### Default Values

```json
{
  "per_page": {
    "type": "integer",
    "default": 20,
    "description": "Items per page"
  }
}
```

### Metadata Parameters

Parameters that control tool behavior but aren't sent to the API:

```json
{
  "tools": [{
    "name": "manage_badges",
    "metadata_params": ["action"],
    "parameters": {
      "action": {
        "type": "string",
        "enum": ["list", "create"],
        "description": "Action to perform"
      }
    }
  }]
}
```

## Interceptors

### Authentication

#### Bearer Token (Recommended)

```json
{
  "interceptors": {
    "auth": {
      "type": "bearer",
      "value_from_env": "MCP4_API_TOKEN",
      "validation_endpoint": "/api/v4/user"
    }
  }
}
```

Adds: `Authorization: Bearer <token>`

**Optional token validation**:
- `validation_endpoint`: API endpoint to verify token (relative to base URL, e.g., `user` or `personal_access_tokens/self`)
- `validation_method`: HTTP method for validation (`GET` or `HEAD`, default: `GET`)
- `validation_timeout_ms`: Timeout in milliseconds (default: `5000`)
- Validates token during initialization to fail fast with invalid tokens
- Improves UX by rejecting bad tokens immediately, not after first tool call
- **Note**: Endpoint is relative to `base_url` from interceptors or `MCP4_API_BASE_URL` environment variable

#### Custom Header

```json
{
  "auth": {
    "type": "custom-header",
    "header_name": "X-API-Key",
    "value_from_env": "API_KEY"
  }
}
```

Adds: `X-API-Key: <token>`

#### Query Parameter

```json
{
  "auth": {
    "type": "query",
    "query_param": "api_key",
    "value_from_env": "API_KEY",
    "validation_endpoint": "status"
  }
}
```

Adds: `?api_key=<token>` to URL

#### Multi-Auth with Priority

Support multiple authentication methods with fallback:

```json
{
  "auth": [
    {
      "type": "oauth",
      "priority": 0,
      "oauth_config": { ... }
    },
    {
      "type": "bearer",
      "priority": 1,
      "value_from_env": "MCP4_API_TOKEN",
      "validation_endpoint": "user"
    }
  ]
}
```

- **Priority**: Lower value = higher priority (default: `0`)
- **Fallback**: First successful authentication is used
- **Use case**: Try OAuth first, fall back to static token
- See [Multi-Auth Guide](./MULTI-AUTH.md) for details

#### OAuth 2.0 Authentication

Browser-based authentication with PKCE flow (HTTP transport only):

```json
{
  "auth": {
    "type": "oauth",
    "oauth_config": {
      "issuer": "https://www.gitlab.com",
      "client_id": "${env:OAUTH_CLIENT_ID}",
      "client_secret": "${env:OAUTH_CLIENT_SECRET}",
      "scopes": ["api", "read_user"],
      "redirect_uri": "http://localhost:3003/oauth/callback"
    },
    "oauth_rate_limit": {
      "max_requests": 20,
      "window_ms": 600000
    }
  }
}
```

- **Autodiscovery**: `issuer` auto-derives authorization/token endpoints (RFC 8414)
- **Rate limiting**: Custom rate limits for OAuth endpoints (default: 10 requests per 10 minutes)
- **Scopes**: Optional, API-specific permissions
- See [OAuth Guide](./OAUTH.md) for complete setup

### Base URL

```json
{
  "base_url": {
    "value_from_env": "MCP4_API_BASE_URL",
    "default": "https://api.example.com/v1"
  }
}
```

### Rate Limiting

```json
{
  "rate_limit": {
    "max_requests_per_minute": 600
  }
}
```

Uses token bucket algorithm to enforce rate limits.

### Retry Logic

```json
{
  "retry": {
    "max_attempts": 3,
    "backoff_ms": [1000, 2000, 4000],
    "retry_on_status": [429, 502, 503, 504]
  }
}
```

Retries failed requests with exponential backoff.

### Array Serialization

```json
{
  "array_format": "brackets"
}
```

Options:
- `brackets`: `?tag[]=a&tag[]=b` (Rails, GitLab)
- `indices`: `?tag[0]=a&tag[1]=b` (PHP)
- `repeat`: `?tag=a&tag=b` (Express, default)
- `comma`: `?tag=a,b,c` (Some APIs)

## Parameter Aliases

Map OpenAPI parameter names to common aliases:

```json
{
  "parameter_aliases": {
    "id": ["project_id", "group_id", "user_id", "resource_id"]
  }
}
```

**Why**: OpenAPI specs often use generic names like `id` in paths. Aliases help map user-provided parameters correctly.

**Note**: Parameter aliases work for both simple tools and composite tools. In composite tools, when a `call` step uses a path parameter like `{id}`, the system will automatically try aliases (e.g., `project_id`) if the direct parameter name is not found in the tool arguments.

## Best Practices

### 1. LLM-Friendly Design

**DO**: Use clear, explicit tool and parameter names
```json
{
  "name": "manage_project_badges",
  "parameters": {
    "action": {
      "description": "Action to perform: list all badges, get specific badge, create new badge, update existing badge, or delete badge"
    }
  }
}
```

**DON'T**: Use vague or ambiguous names
```json
{
  "name": "badges",
  "parameters": {
    "action": {
      "description": "What to do with badges"
    }
  }
}
```

### 2. Tool Aggregation

Combine related operations into unified tools to reduce context pollution:

**Before**: 5 separate tools
- `list_project_badges`
- `get_project_badge`
- `create_project_badge`
- `update_project_badge`
- `delete_project_badge`

**After**: 1 aggregated tool
```json
{
  "name": "manage_project_badges",
  "operations": {
    "list": "...",
    "get": "...",
    "create": "...",
    "update": "...",
    "delete": "..."
  }
}
```

### 3. Composite Tools for Common Workflows

Create composite tools for multi-step operations users frequently need (reduces LLM requests and latency).

#### Sequential Execution (Default)

```json
{
  "name": "get_merge_request_with_context",
  "composite": true,
  "steps": [
    { "call": "getMergeRequest", "store_as": "mr" },
    { "call": "getMRComments", "store_as": "mr.comments" },
    { "call": "getMRApprovals", "store_as": "mr.approvals" }
  ]
}
```

All steps execute sequentially. Comments and approvals wait for MR to load first.

#### Parallel Execution with Dependencies

```json
{
  "name": "get_project_with_context",
  "composite": true,
  "steps": [
    { "call": "getProject", "store_as": "project" },
    {
      "call": "getProjectMergeRequests",
      "store_as": "merge_requests",
      "depends_on": ["project"]
    },
    {
      "call": "getProjectIssues",
      "store_as": "issues",
      "depends_on": ["project"]
    },
    {
      "call": "getProjectMembers",
      "store_as": "members",
      "depends_on": ["project"]
    }
  ]
}
```

- **Level 1**: `project` (no dependencies)
- **Level 2**: `merge_requests`, `issues`, `members` (all depend on `project`) - **run in parallel**
- **Performance**: ~3x faster than sequential execution

#### Complex DAG Dependencies

```json
{
  "name": "get_mr_with_full_context",
  "composite": true,
  "steps": [
    { "call": "getMergeRequest", "store_as": "mr" },
    {
      "call": "getMRComments",
      "store_as": "comments",
      "depends_on": ["mr"]
    },
    {
      "call": "getMRApprovals",
      "store_as": "approvals",
      "depends_on": ["mr"]
    },
    {
      "call": "getCommentAuthors",
      "store_as": "comment_authors",
      "depends_on": ["comments"]
    },
    {
      "call": "getApprovalUsers",
      "store_as": "approval_users",
      "depends_on": ["approvals"]
    },
    {
      "call": "mergeContexts",
      "store_as": "full_context",
      "depends_on": ["comment_authors", "approval_users"]
    }
  ]
}
```

**Execution order**:
1. `mr` (independent)
2. `comments`, `approvals` (parallel, depend on `mr`)
3. `comment_authors`, `approval_users` (parallel, depend on their respective data)
4. `full_context` (depends on both author lists)

**Dependency Rules**:
- `depends_on` must reference `store_as` values from other steps
- No circular dependencies (detected at profile load time)
- Independent steps automatically parallelized

### 4. Use Metadata Parameters

Keep tool definitions clean by marking control parameters:

```json
{
  "metadata_params": ["action", "resource_type"],
  "parameters": {
    "action": { ... },
    "resource_type": { ... },
    "id": { ... }
  }
}
```

### 5. Validate Early

Test your profile as you build:

```bash
# Validate without API access
npm run validate -- profiles/my-profile.json

# Validate with OpenAPI spec check
npm run validate -- profiles/my-profile.json openapi.yaml

# Test with actual API
npm run build
export MCP4_PROFILE_PATH=./profiles/my-profile.json
export MCP4_OPENAPI_SPEC_PATH=./openapi.yaml
npm start
```

The `validate` command checks:
- JSON syntax
- Schema compliance (types, required fields)
- Logical consistency (duplicate names, parameter references)
- Operations exist in OpenAPI spec (if spec provided)
- Best practices (tool count, auth configuration)

## Security Best Practices

### Input Validation

Always validate user inputs in your OpenAPI specification to prevent attacks:

#### Text Fields with Length Limits
```yaml
# Prevent DoS attacks with oversized strings
title:
  type: string
  minLength: 1
  maxLength: 255  # GitLab limit for titles

description:
  type: string
  maxLength: 1048576  # 1MB, prevents storage bombs
```

#### Integer Fields with Ranges
```yaml
# Prevent integer overflow and invalid IDs
user_id:
  type: integer
  minimum: 1
  maximum: 2147483647  # INT32_MAX

weight:
  type: integer
  minimum: 0
  maximum: 100  # Reasonable upper bound
```

### Rate Limiting for Write Operations

Write operations (POST, PUT, DELETE) should have **stricter rate limits** than read operations to prevent abuse:

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
        },
        "postApiV4ProjectsIdMergeRequests": {
          "max_requests_per_minute": 10
        },
        "deleteApiV4ProjectsIdMergeRequestsMergeRequestIid": {
          "max_requests_per_minute": 5
        }
      }
    }
  }
}
```

**Recommended limits:**
- **Read operations**: 120-600 req/min (default)
- **Write operations**: 10-20 req/min
- **Delete operations**: 5-10 req/min
- **Batch operations**: 1-5 req/min

Rate limits are enforced **per API token** to prevent spam and abuse.

### XSS Prevention

- Always sanitize HTML content in descriptions
- Use API's built-in rendering (e.g., GitLab markdown sanitizes by default)
- **Never render user input as raw HTML**
- Validate content types before processing

### CSRF Protection

For state-changing operations:
1. ✅ Use proper HTTP methods (POST/PUT/DELETE, **not GET**)
2. ✅ Include API tokens in headers (**not query params**)
3. ✅ Validate Origin/Referer headers in production
4. ✅ Use HTTP transport's session management

### Project ID Format Validation

GitLab API endpoints have **inconsistent support** for project ID formats:

```json
{
  "project_id": {
    "description": "Project ID (numeric like '123' or URL-encoded path like 'group%2Fproject')",
    "example": "123"
  }
}
```

**Supported formats by GitLab API:**
- ✅ **Numeric IDs** (e.g., `123`) - Always supported, most reliable
- ✅ **URL-encoded paths** (e.g., `group%2Fproject`) - Supported (encode `/` as `%2F`)
- ❌ **Short names** (e.g., `my-project`) - **NOT supported** (returns 404)
- ❌ **Plain paths** (e.g., `group/project`) - **NOT supported** (returns 404)

### Authorization Testing

Always test authorization failures in your integration tests:

```typescript
it('should reject unauthorized delete (403)', async () => {
  await expect(
    executeOperation('delete_issue', {
      project_id: 'forbidden-project',
      issue_iid: 1,
    })
  ).rejects.toThrow(/403|Forbidden/);
});
```

### Token Validation

Enable token validation to fail fast with invalid credentials:

```json
{
  "interceptors": {
    "auth": {
      "type": "bearer",
      "value_from_env": "MCP4_API_TOKEN",
      "validation_endpoint": "personal_access_tokens/self",
      "validation_method": "GET",
      "validation_timeout_ms": 5000
    }
  }
}
```

**Benefits**:
- Rejects invalid tokens immediately during server startup
- Better error messages (invalid token vs API error)
- Prevents wasted API calls with bad credentials
- Improves developer experience

**Validation endpoint examples** (relative to base URL):
- GitLab (base: `https://gitlab.com/api/v4`): `personal_access_tokens/self` or `user`
- GitHub (base: `https://api.github.com`): `user`
- Generic: Any endpoint that returns 401/403 for invalid tokens

### Security Checklist

Before deploying your profile:

- [ ] **Input validation**: All text fields have `maxLength`
- [ ] **Integer validation**: All ID fields have `minimum`/`maximum`
- [ ] **Rate limits**: Write operations have strict limits
- [ ] **Authorization tests**: 403/401 scenarios covered
- [ ] **URL parsing**: Robust against path traversal
- [ ] **Error messages**: Don't leak sensitive information
- [ ] **API tokens**: Stored in environment variables, not code
- [ ] **Token validation**: Enable `validation_endpoint` to fail fast
- [ ] **HTTPS only**: `base_url` uses `https://`

## Common Patterns

### Pattern 1: Resource Manager

Manage a single resource type with CRUD operations:

```json
{
  "name": "manage_<resource>",
  "operations": {
    "list": "get<Resources>",
    "get": "get<Resource>Id",
    "create": "post<Resources>",
    "update": "put<Resource>Id",
    "delete": "delete<Resource>Id"
  },
  "parameters": {
    "action": {
      "type": "string",
      "enum": ["list", "get", "create", "update", "delete"],
      "required": true
    },
    "id": {
      "required_for": ["get", "update", "delete"]
    }
  }
}
```

### Pattern 2: Polymorphic Resource

Handle multiple resource types with one tool:

```json
{
  "name": "manage_access_requests",
  "operations": {
    "list_project": "getProjectAccessRequests",
    "list_group": "getGroupAccessRequests",
    "approve_project": "putProjectAccessRequestsUserId",
    "approve_group": "putGroupAccessRequestsUserId"
  },
  "parameters": {
    "resource_type": {
      "type": "string",
      "enum": ["project", "group"],
      "required": true
    },
    "action": {
      "type": "string",
      "enum": ["list", "approve"],
      "required": true
    }
  }
}
```

**Note**: Operation keys must either be direct action names (from the `action` enum) or follow the `{action}_{resource_type}` pattern where both parts are valid enum values. Invalid keys are caught at profile load time with helpful error messages and suggestions.

### Pattern 3: Read-Only List with Filters

Provide filterable list endpoint:

```json
{
  "name": "list_issues",
  "operations": {
    "list": "getIssues"
  },
  "parameters": {
    "status": {
      "type": "string",
      "enum": ["open", "closed", "all"],
      "default": "open"
    },
    "assignee": {
      "type": "string"
    },
    "labels": {
      "type": "array",
      "items": { "type": "string" }
    }
  }
}
```

## Troubleshooting

### Issue: "Operation not found"

**Cause**: `operationId` in profile doesn't match OpenAPI spec

**Fix**: Check your OpenAPI spec:
```bash
grep -r "operationId" your-openapi.yaml
```

### Issue: "Parameter not found in operation"

**Cause**: Parameter name doesn't match OpenAPI spec

**Fix**: Add parameter aliases:
```json
{
  "parameter_aliases": {
    "id": ["project_id", "badge_id"]
  }
}
```

### Issue: "Required parameter missing"

**Cause**: `required_for` condition not met or parameter truly missing

**Fix**: Check parameter conditions:
```json
{
  "badge_id": {
    "required_for": ["get", "update", "delete"]
  }
}
```

### Issue: Profile validation fails

**Cause**: Invalid JSON or schema violation

**Fix**:
1. Check JSON syntax (use IDE with JSON Schema support)
2. Verify against `profile-schema.json`
3. Check build output for specific errors

## Examples

See working examples in `profiles/examples/`:

- **GitLab Developer**: `profiles/examples/gitlab/developer-profile.json`
  - 5 aggregated tools
  - 1 composite tool
  - Bearer auth
  - Rate limiting & retry

## Important: Schema Synchronization

**✅ Schemas are now auto-synchronized!**

**When adding new fields to `ToolDefinition` or `Profile` types:**

1. **Update TypeScript types** in `src/types/profile.ts`
2. **Run `npm run build`** (auto-generates Zod schemas + compiles)
3. **Optionally update JSON Schema** in `profile-schema.json` (for better IDE support)

**Note:** `npm run generate-schemas` runs automatically during build, so you don't need to remember it!

**Why this approach?**
- **TypeScript types**: Single source of truth, full type safety
- **Zod schemas**: Auto-generated from TypeScript, runtime validation
- **JSON Schema**: Manual maintenance for rich IDE autocomplete (examples, descriptions)

**Example: Adding `response_fields`**

```typescript
// 1. src/types/profile.ts
export interface ToolDefinition {
  // ... existing fields ...
  response_fields?: Record<string, string[]>;
}

// 2. Run: npm run build
// → Auto-generates src/generated-schemas.ts with proper Zod validation

// 3. Optional: Update profile-schema.json for better IDE experience
{
  "properties": {
    "response_fields": {
      "type": "object",
      "description": "Response field filtering per action",
      "additionalProperties": {
        "type": "array",
        "items": { "type": "string" }
      },
      "examples": [{
        "list": ["id", "name", "path", "web_url"]
      }]
    }
  }
}
```

**Debugging tip:** If a profile field is ignored at runtime, run `npm run generate-schemas` to ensure Zod schemas are up-to-date!

## Next Steps

1. Study the GitLab example profile
2. Copy and adapt for your API
3. Start with simple tools, add composite tools later
4. Test incrementally
5. Share your profile!

## Reference

- [OpenAPI Specification](https://spec.openapis.org/oas/v3.1.0)
- [JSON Schema](https://json-schema.org/)
- [MCP SDK Documentation](https://github.com/microsoft/mcp-sdk)
- [Zod Documentation](https://zod.dev/)
- Profile Schema: `profile-schema.json`
