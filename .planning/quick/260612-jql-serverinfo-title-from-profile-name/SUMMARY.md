---
status: complete
date: 2026-06-12
slug: serverinfo-title-from-profile-name
---

# Quick Task 260612-jql: ServerInfo title from profile_name - Summary

Implemented `serverInfo.title` generation from the loaded profile `profile_name` in `MCPServer`, with an optional cached `MCP4_SERVERINFO_SUFFIX` applied at server construction time. `serverInfo.name` remains unchanged.

## Completed Work
- Added shared MCP server identity constants and a local `InitializeServerInfo` type in `src/mcp/mcp-server.ts`.
- Added `getProfileNameValue()`, cached `resolveServerInfoSuffix()`, and `buildInitializeServerInfo()` so initialize metadata is composed in one place.
- Preserved fail-fast behavior by throwing when `profile_name` is missing or unusable.
- Strengthened `src/mcp/mcp-server.test.ts` for default title, cached suffix behavior, unchanged name, and empty-name failure path.
- Reworked `src/mcp/mcp-server-manager.test.ts` to use two deterministic temporary routed profiles and assert distinct per-profile `serverInfo.title` values.
- Updated `README.md`, `docs/HTTP-TRANSPORT.md`, `env.example`, and `CHANGELOG.md` for the new title behavior and `MCP4_SERVERINFO_SUFFIX`.

## Verification
- `npx vitest run src/mcp/mcp-server.test.ts src/mcp/mcp-server-manager.test.ts`
- `npm run typecheck`

## Result
- HTTP and stdio initialize responses now advertise the active profile label via `serverInfo.title`.
- Routed HTTP profiles expose different titles per `/profile/:profileId/mcp` connection.
- No commit was created in this run; changes are currently in the working tree on top of `751aae1`.
