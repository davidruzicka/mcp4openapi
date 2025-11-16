# GitLab API Example

Complete working example using MCP server with GitLab API.

## Results

For GitLab API specifically:
- Reduced from 200+ potential tools to 9 aggregated tools
- 85% reduction in MCP tool count
- Tested with real GitLab OpenAPI specification

## Setup

### 1. Get GitLab API Token

Visit https://gitlab.com/-/user_settings/personal_access_tokens and create a token with appropriate scopes.

### 2. Configure Environment

Reuse the [README Quick Start](../README.md#quick-start) instructions to load the GitLab specification and profile. Substitute:

- `OPENAPI_SPEC_PATH=profiles/examples/gitlab/openapi.yaml`
- `MCP_PROFILE_PATH=profiles/examples/gitlab/developer-profile.json`
- `API_TOKEN=<your GitLab token>`
- `API_BASE_URL=https://gitlab.com/api/v4`

### 3. Run

Follow the [standard launch steps](../README.md#quick-start) (`npm start` or `npx mcp4openapi`) after installing dependencies.

## Available Tools

The `profiles/examples/gitlab/developer-profile.json` profile provides 9 aggregated tools.
Some of them are:

### 1. manage_groups

Work with GitLab groups (list, get, list_projects, list_subgroups).

Example - list all groups:
```json
{
  "action": "list"
}
```

Example - get group details:
```json
{
  "action": "get",
  "group_id": "ai-adoption"
}
```

### 2. manage_projects

Work with GitLab projects (list, get).

Example - list all projects:
```json
{
  "action": "list",
  "membership": true
}
```

Example - get project details:
```json
{
  "action": "get",
  "project_id": "123"
}
```

### 3. manage_merge_requests

Work with merge requests (list, get, create, delete).

Example - list merge requests:
```json
{
  "project_id": "123",
  "action": "list",
  "state": "opened"
}
```

Example - create merge request:
```json
{
  "project_id": "123",
  "action": "create",
  "source_branch": "feature/new-feature",
  "target_branch": "main",
  "title": "Implement new feature"
}
```

### 4. manage_issues

Work with issues (list, get, create, delete).

Example - list issues:
```json
{
  "project_id": "123",
  "action": "list",
  "state": "opened"
}
```

Example - create issue:
```json
{
  "project_id": "123",
  "action": "create",
  "title": "Bug: Application crashes on startup"
}
```

### 5. manage_project_badges

Manage badges for a project (list, get, create, update, delete).

Example - list badges:
```json
{
  "project_id": "123",
  "action": "list"
}
```

Example - create badge:
```json
{
  "project_id": "123",
  "action": "create",
  "link_url": "https://example.com",
  "image_url": "https://example.com/badge.svg"
}
```

### 6. manage_branches

Manage repository branches (list, get, create, delete, protect, unprotect, exists).

Example - create branch:
```json
{
  "project_id": "123",
  "action": "create",
  "branch": "feature/new-feature",
  "ref": "main"
}
```

Example - protect branch:
```json
{
  "project_id": "123",
  "action": "protect",
  "branch": "main"
}
```

### 7. manage_access_requests

Manage access requests for projects or groups (list, approve, deny, request).

Example - list access requests:
```json
{
  "resource_type": "project",
  "resource_id": "123",
  "action": "list"
}
```

Example - approve access request:
```json
{
  "resource_type": "group",
  "resource_id": "ai-adoption",
  "action": "approve",
  "user_id": 456,
  "access_level": 30
}
```

### 8. list_project_jobs

List CI/CD jobs for a project with optional status filtering.

Example:
```json
{
  "project_id": "123",
  "scope": ["failed", "canceled"]
}
```

### 9. manage_job

Manage a specific CI/CD job (get details, play manual job).

Example - get job details:
```json
{
  "project_id": "123",
  "action": "get",
  "job_id": 1234
}
```

Example - trigger manual job:
```json
{
  "project_id": "123",
  "action": "play",
  "job_id": 1234
}
```

## Example Profile Configuration

The `gitlab-developer.json` profile includes:

### Interceptors

- **Auth**: Bearer token configurable via `API_TOKEN` environment variable
- **Base URL**: Configurable via `API_BASE_URL` (default: `https://gitlab.com/api/v4`)
- **Rate Limit**: 600 requests/minute global, with overrides for destructive operations
- **Retry**: 3 attempts with exponential backoff [1s, 2s, 4s]
- **Retry Status Codes**: 429, 502, 503, 504
- **Array Format**: brackets (for query parameters like `scope[]`)

### Tool Aggregation Strategy

Each tool groups related operations:

- `manage_groups`: 4 operations (list, get, list_projects, list_subgroups)
- `manage_projects`: 2 operations (list, get)
- `manage_merge_requests`: 4 operations (list, get, create, delete)
- `manage_issues`: 4 operations (list, get, create, delete)
- `manage_project_badges`: 5 operations (list, get, create, update, delete)
- `manage_branches`: 7 operations (list, get, create, delete, protect, unprotect, exists)
- `manage_access_requests`: 8 operations (list/approve/deny/request for project/group)
- `list_project_jobs`: 1 operation with filtering
- `manage_job`: 2 operations (get, play)

Total: 37+ operations aggregated into 9 tools.

## Testing

The project includes integration tests using a mock GitLab server:

```bash
npm test
```

Tests cover:
- All 9 tools
- CRUD operations
- Error scenarios (404, 403)
- Query parameter handling
- Resource type discrimination (project vs group)
- Pagination and filtering

## Claude Desktop Integration

Add to your `mcp.json`:

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "node",
      "args": ["/path/to/mcp4openapi/dist/index.js"],
      "env": {
        "OPENAPI_SPEC_PATH": "/path/to/profiles/examples/gitlab/openapi.yaml",
        "MCP_PROFILE_PATH": "/path/to/profiles/examples/gitlab/developer-profile.json",
        "API_TOKEN": "glpat-xxxxxxxxxxxxxxxxxxxx",
        "API_BASE_URL": "https://gitlab.com/api/v4"
      }
    }
  }
}
```

## Common Use Cases

### Discover Projects and Groups

List groups you're member of:
```json
{
  "tool": "manage_groups",
  "arguments": {
    "action": "list",
    "owned": true
  }
}
```

List your projects:
```json
{
  "tool": "manage_projects",
  "arguments": {
    "action": "list",
    "membership": true
  }
}
```

### Work with Merge Requests

Create a merge request:
```json
{
  "tool": "manage_merge_requests",
  "arguments": {
    "project_id": "123",
    "action": "create",
    "source_branch": "feature/new-feature",
    "target_branch": "main",
    "title": "Add new feature",
    "description": "This PR implements feature X"
  }
}
```

List open merge requests:
```json
{
  "tool": "manage_merge_requests",
  "arguments": {
    "project_id": "123",
    "action": "list",
    "state": "opened"
  }
}
```

### Create and Track Issues

Create an issue:
```json
{
  "tool": "manage_issues",
  "arguments": {
    "project_id": "123",
    "action": "create",
    "title": "Bug: Application crashes on startup",
    "labels": "bug,critical"
  }
}
```

### Check Failed CI Jobs

```json
{
  "tool": "list_project_jobs",
  "arguments": {
    "project_id": "123",
    "scope": ["failed"]
  }
}
```

### Manage Branches

Create feature branch:
```json
{
  "tool": "manage_branches",
  "arguments": {
    "project_id": "123",
    "action": "create",
    "branch": "feature/implement-x",
    "ref": "main"
  }
}
```

Protect main branch:
```json
{
  "tool": "manage_branches",
  "arguments": {
    "project_id": "123",
    "action": "protect",
    "branch": "main"
  }
}
```

### Approve Access Request

```json
{
  "tool": "manage_access_requests",
  "arguments": {
    "resource_type": "group",
    "resource_id": "ai-adoption",
    "action": "approve",
    "user_id": 456,
    "access_level": 30
  }
}
```

Access levels:
- 10 = Guest
- 20 = Reporter
- 30 = Developer (default)
- 40 = Maintainer
- 50 = Owner

## Troubleshooting

### Authentication Errors

Verify your token (`read_user` right is required):
```bash
curl -H "Authorization: Bearer $API_TOKEN" https://gitlab.com/api/v4/user
```

### Rate Limiting

If hitting rate limits, adjust in profile:
```json
{
  "interceptors": {
    "rate_limit": {
      "max_requests_per_minute": 300
    }
  }
}
```

### Self-Hosted GitLab

Ensure API is accessible and use correct base URL:
```bash
export API_BASE_URL=https://gitlab.yourcompany.com/api/v4
```

## Creating Custom Profiles

You can create additional profiles for different use cases:

- `profiles/gitlab/admin-profile.json` - Include admin operations
- `profiles/gitlab/readonly-profile.json` - Only GET operations
- `profiles/gitlab/ci-profile.json` - Focus on CI/CD operations

See `profiles/gitlab/developer-profile.json` as a template and `profile-schema.json` for the JSON schema.

## OpenAPI Specification

The `profiles/gitlab/openapi.yaml` file is a partial GitLab API specification used for testing.

For complete GitLab API documentation, see:
https://docs.gitlab.com/ee/api/

To update the specification:
1. Download from GitLab repository
2. Place in `profiles/gitlab/` directory as `openapi.yaml`
3. Rebuild profile if adding new operations
