---
name: codex-mcp-config-format-matrix
description: Use when generating or reviewing MCP configuration snippets for Codex (CLI/TOML) to enforce Codex-native auth and format rules.
---

## Goal
Generate correct Codex MCP snippets without mixing conventions from other clients.

## When to Use
- A task adds or edits Codex snippets in profile index pages.
- A review checks Codex CLI or TOML examples.

## Rules
1. For Codex TOML in `[mcp_servers.<name>]` sections:
    - with bearer auth, use `bearer_token_env_var = "<ENV_VAR_NAME>"` - do not encode bearer auth in TOML as `Authorization` header values.
    - when `bearer_token_env_var` is set, do not duplicate the same variable in `env_vars`.
    - with custom header, use `http_headers = { "Header-Name" = "value" }`.
    - with custom header that uses environment variable as a value, use `env_http_headers = { "Header-Name" = "<ENV_VAR_NAME>" }`.
    - for environment variables mapping from host, use `env_vars =["<ENV_VAR_NAME>", ...]`.
2. For Codex CLI:
    - with bearer auth which uses defined environment variable as a token, use `--bearer-token-env-var <ENV_VAR_NAME>`.
    - don't generate CLI snippet other than OAuth or bearer auth - pure command line arguments doesn't support `custom-header` or `query` authentication types and also doesn't support environment variables mapping from host.
3. `env` TOML snippets should be used to define environment variables:
    ```toml
    [mcp_servers.<server_name>.env]
    ENV_VAR_NAME = "value"
    ```
4. Keep Codex snippets client-native:
- TOML snippets use `[mcp_servers.<name>]`.
- CLI snippets use `codex mcp add <mcp_server_name> --url "https://..."` for HTTP streamable MCP servers and `codex mcp add <mcp_server_name> -- npx -y mpc4openapi --profile <profile_name> ...` for stdio MCP servers.
5. Keep env placeholders aligned with the target format:
- Codex TOML/CLI uses `${VAR}` style values when variable interpolation is shown.

## Validation Checklist
- Bearer TOML contains `bearer_token_env_var` and no embedded bearer header.
- Bearer TOML does not duplicate the bearer variable in `env_vars`.
- Non-bearer custom headers in TOML are emitted via `http_headers`.
- Snippet tests cover bearer and query/custom-header paths.
