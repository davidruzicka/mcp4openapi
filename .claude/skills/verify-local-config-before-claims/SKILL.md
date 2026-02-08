---
name: verify-local-config-before-claims
description: Verify repository configuration locally before making conclusions about MCP/server setup. Use when asked to diagnose configuration, profile routing, auth behavior, endpoints, env vars, or profile IDs/aliases in this workspace.
---

# Verify Local Config Before Claims

1. Inspect local source of truth before answering.
- Read relevant profile files under `profiles/`.
- Check transport and auth behavior in `src/transport/http-transport.ts` and related docs.
- Verify route format and profile selection from `README.md` and `docs/HTTP-TRANSPORT.md`.

2. Confirm claims with concrete evidence.
- Cite exact file paths and key values (profile id, aliases, auth type, env var names, endpoint paths).
- Prefer direct file reads over memory or assumptions.

3. Distinguish static config from runtime prerequisites.
- State whether config syntax is valid.
- Separately list runtime conditions required for it to work (enabled transport mode, env vars set, profile routing on).

4. Resolve conflicts explicitly.
- If docs and code differ, prioritize code and note the discrepancy.
- If multiple profiles exist, identify which one matches the user snippet.

5. Avoid speculative diagnoses.
- Do not claim a field is wrong unless a local check confirms it.
- When unsure, run one more targeted file check before concluding.
