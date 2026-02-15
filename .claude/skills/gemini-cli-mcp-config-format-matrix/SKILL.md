---
name: gemini-cli-mcp-config-format-matrix
description: Use when generating or reviewing Gemini CLI MCP configuration snippets in this repository (profile index/docs). Enforce Gemini-native settings.json mcpServers format and gemini mcp add/list/remove command syntax for stdio and streamable HTTP servers.
---

## Goal
Generate correct Gemini CLI MCP configuration without mixing formats from other clients.

## Rules
1. Prefer Gemini-native JSON config in `settings.json`:
   - top-level `mcpServers` for server entries.
   - optional top-level `mcp` for global policies (`allowed`, `excluded`, optional `serverCommand`).
2. For stdio servers, use server entry fields compatible with Gemini CLI:
   - `command`, optional `args`, optional `env`, optional `cwd`, optional `timeout`, optional `trust`.
3. For streamable HTTP servers, use `httpUrl` in server entry.
4. For HTTP auth headers, use Gemini-native header mapping:
   - JSON: `headers: { "Authorization": "Bearer ..." }`
   - CLI: `--header "Authorization: Bearer ..."`
5. Keep Gemini snippets client-native:
   - Do not emit Codex TOML fields (`bearer_token_env_var`, `http_headers`, `env_http_headers`).
   - Do not emit Claude Desktop MCP format.
6. Preserve secure placeholder values in examples:
   - Prefer placeholders like `${TOKEN_ENV_VAR}` in JSON examples instead of hardcoded secrets.
7. When server filtering is required, use Gemini fields:
   - `includeTools` / `excludeTools` on the server entry.
8. When generating commands for management operations, use Gemini CLI verbs:
   - `gemini mcp add -s user ...`
   - `gemini mcp list`
   - `gemini mcp remove <name>`

## Output Patterns
- Local stdio snippet: JSON `mcpServers.<name>.command` with optional `args` and `env`.
- Remote streamable snippet: JSON `mcpServers.<name>.httpUrl` with optional `headers`.

## JSON Examples (Gemini Docs Aligned)
Use these as canonical formatting references for `settings.json`.

### Stdio server with args, env
```json
{
  "mcpServers": {
    "gitlab": {
      "command": "npx",
      "args": ["-y", "mcp4openapi", "--profile", "gitlab"]
    }
  }
}
```

### Streamable HTTP server with OAuth (or none) autentization
```json
{
  "mcpServers": {
    "gitlab": {
      "httpUrl": "https://<cmp_server_host>/profile/gitlab/mcp"
    }
  }
}
```

### Streamable HTTP server with headers

- Bearer token in header:

```json
{
  "mcpServers": {
    "gitlab": {
      "httpUrl": "https://<cmp_server_host>/profile/gitlab/mcp",
      "headers": {
        "Authorization": "Bearer ${GITLAB_TOKEN}"
      }
    }
  }
}
```

- custom header:

```json
{
  "mcpServers": {
    "custom": {
      "httpUrl": "https://<cmp_server_host>/profile/custom/mcp",
      "headers": {
        "X-Custom-Header": "${CUSTOM_TOKEN}"
      }
    }
  }
}
```

### Add streamable HTTP server with query param auth

```json
{
  "mcpServers": {
    "custom": {
      "httpUrl": "https://<cmp_server_host>/profile/custom/mcp?token=${QUERY_TOKEN}"
    }
  }
}
```

## Command Line Examples (gemini mcp add)

### Add local stdio server
```bash
gemini mcp add -s user gitlab -- npx -y mcp4openapi --profile gitlab
```

### Add streamable HTTP server (no auth)
```bash
gemini mcp add -s user --transport http gitlab https://<mcp_server_host>/profile/gitlab/mcp
```

### Add streamable HTTP server with bearer header
```bash
gemini mcp add -s user --transport http gitlab https://<mcp_server_host>/profile/gitlab/mcp \
  --header "Authorization: Bearer \${GITLAB_TOKEN}"
```

### Add streamable HTTP server with custom header
```bash
gemini mcp add -s user --transport http custom https://<mcp_server_host>/profile/custom/mcp \
  --header "X-Custom-Header: \${CUSTOM_TOKEN}"
```

### Add streamable HTTP server with query token in URL
```bash
gemini mcp add -s user --transport http custom https://<mcp_server_host>/profile/custom/mcp?token=\${QUERY_TOKEN}
```

## Validation Checklist
- Snippet format is valid JSON for `settings.json` (no comments, no trailing commas).
- Transport key matches target mode (`command` for stdio, `httpUrl` for HTTP).
- Auth is expressed with Gemini-supported `headers` or `--header`.
- No cross-client configuration keys appear in Gemini snippets.
- No SSE transport snippet is generated.
