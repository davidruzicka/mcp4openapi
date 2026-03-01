# Process-Scoped Parameter Filter Plan

## Goal
- Add a global `MCP4_PARAM_FILTER` / `--param-filter` that applies process-wide in both `stdio` and `http` modes.
- Keep existing `MCP4_TOOL_FILTER_*` as the process-wide tool filter mechanism.
- Implement backend/runtime behavior first.
- Update the HTML profile index only after backend behavior is complete and tested.

## Decisions
- Reuse existing `MCP4_TOOL_FILTER_*` for tool filtering in all transports.
- Introduce only one new process-wide parameter filter input: `MCP4_PARAM_FILTER` / `--param-filter`.
- `MCP4_PARAM_FILTER` uses the same format and validation as `X-Mcp4-Params`.
- In `http`, global param filtering is the baseline and per-session `X-Mcp4-Params` may only narrow it.
- In `stdio`, global param filtering applies process-wide; any existing stdio initialize `params.filtering` behavior must remain compatible and may only narrow it.
- HTML profile index changes are phase 2 and must not begin before backend phase 1 is validated.

## Phase 1 - Backend/runtime
- [x] Add `MCP4_PARAM_FILTER` to CLI/env mapping (`--param-filter`).
- [x] Add reusable global param filter parsing helper in `src/core/filtering.ts`.
- [x] Add reusable filter merge helper in `src/core/filtering.ts` with conservative control-key semantics.
- [x] Add unit tests for parsing and merge behavior in `src/core/filtering.test.ts`.
- [x] Wire global param filtering into startup in `src/core/index.ts`.
- [x] Add process-scoped param filtering support to `MCPServer` for stdio mode.
- [x] Ensure existing stdio initialize `params.filtering` narrows, not replaces, the global filter.
- [x] Add global param filtering support to `HttpTransport` session creation in HTTP mode.
- [x] Store effective merged filtering rules in HTTP session state while preserving the raw session header for mismatch checks.
- [x] Keep existing `X-Mcp4-Params` mismatch behavior unchanged for subsequent HTTP requests.
- [x] Wire global param filtering into `MCPServerManager` / HTTP profile routing path.
- [x] Add targeted tests for CLI mapping, stdio filtering, HTTP session filtering, and conflict cases.
- [x] Run `npm run typecheck`.
- [x] Run targeted tests for core filtering, CLI config, MCP server, and HTTP transport.

## Phase 2 - HTML profile index
- [ ] Update local snippet generation so filter selections work for `Local stdio` too.
- [ ] Map local tool selections to existing `MCP4_TOOL_FILTER_*` outputs.
- [ ] Map local parameter selections to `MCP4_PARAM_FILTER` output.
- [ ] Make snippet capability gating mode-aware (remote custom headers vs local env/CLI injection).
- [ ] Keep existing remote `X-Mcp4-Tools` / `X-Mcp4-Params` behavior unchanged.
- [ ] Update profile index tests for local filtered snippets.
- [ ] Verify in browser after server restart.

## Docs
- [ ] Update `README.md` for `MCP4_PARAM_FILTER` and transport semantics.
- [ ] Update `docs/HTTP-TRANSPORT.md` for global-vs-session filtering rules.
- [ ] Update `CHANGELOG.md` with user-facing summary.

## Acceptance criteria
- [x] `--param-filter` is accepted and mapped to `MCP4_PARAM_FILTER`.
- [x] `MCP4_PARAM_FILTER` is enforced in `stdio` without HTTP sessions.
- [x] `MCP4_PARAM_FILTER` is enforced in `http` as a global baseline.
- [x] `X-Mcp4-Params` in `http` can only narrow the global baseline.
- [x] Existing `MCP4_TOOL_FILTER_*` behavior remains unchanged.
- [x] Backend phase is fully validated before any HTML index changes begin.
