# MCP Tool Filtering Plan

This document extends the existing MCP filtering work to cover entire tools. It splits the effort into two complementary layers: a global filter driven by environment variables (for trimming generated profiles across every session) and a session-scoped header filter (for temporary restrictions such as AI reviewers). Use the checklist items below to track implementation progress end-to-end, from configuration parsing to enforcement and tests.

## Goal
- [x] Introduce global tool filtering via environment variables (static, applies to all sessions).
- [x] Introduce session-scoped tool filtering via `X-Mcp4-Tools` header (dynamic, restricts specific sessions).

## Part 1: Global Environment Filtering (Static)
This filter applies when the profile is loaded. It removes tools from the server's available set immediately, making them unavailable to all clients.

### Environment Variables
- [x] `MCP4_TOOL_FILTER_ALLOW_LIST`: Comma-separated list of exact tool names to keep. If present, only these tools (and those matching regex) are allowed.
- [x] `MCP4_TOOL_FILTER_ALLOW_REGEX`: JavaScript regex pattern to match allowed tool names (e.g. `get.*` which becomes `^get.*$`). **Patterns are automatically anchored** with `^...$` unless already present.
- [x] `MCP4_TOOL_FILTER_DENY_LIST`: Comma-separated list of exact tool names to exclude.
- [x] `MCP4_TOOL_FILTER_DENY_REGEX`: JavaScript regex pattern to exclude tool names (automatically anchored).
- [x] `MCP4_TOOL_FILTER_ALLOW_COMPOSITES`: Include `_allow_list` and/or `_allow_read` keywords to allow composite tools of those types without explicit naming.

### Regex Security
- [x] **ReDoS Protection**: Validate regex patterns at parse time. Reject patterns exceeding complexity threshold (e.g., max 100 chars, no nested quantifiers like `(a+)+`).
- [x] **Alternation Guard**: Reject regex groups with alternation followed by quantifiers to reduce backtracking risk.
- [x] **Auto-anchoring**: All regex patterns without explicit `^` prefix and `$` suffix are automatically anchored to prevent partial matches. Example: `user` becomes `^user$`, `.*user.*` stays as-is.
- [x] **Case Sensitivity**: Tool name matching is **case-sensitive** per MCP specification (tools are identifiers).

### Logic
- [x] Applied during `ProfileLoader.load()` or `McpServer` initialization.
- [x] If allow-list/regex is defined, tool is rejected unless it matches at least one.
- [x] If deny-list/regex is defined, tool is rejected if it matches any.
- [x] Deny rules take precedence over allow rules (strict exclusions).
- [x] **No-op Detection**: If filter configuration exists but doesn't change the tool set (neither removes nor adds), fail with `ConfigurationError: Tool filter configuration has no effect. Original tool count: N, filtered: N. Check MCP4_TOOL_FILTER_* patterns.`
- [x] If filtering removes every tool, fail initialization with `ConfigurationError: All tools filtered out (original: N). Check MCP4_TOOL_FILTER_* settings. Removed by: [list filter sources].`
- [x] **Filters only remove, never add**: Global env filters reduce the available tool set. Session headers further restrict from that reduced set. A session cannot "recover" tools removed by global filters (global filter can remove tools from internal evidence completely after logging).

## Part 2: Session-Scoped Header Filtering (Dynamic)
This filter applies per-session via HTTP transport, allowing AI agents to request a restricted view of the toolbox.

### Header Format
- [x] **Header Name**: `X-Mcp4-Tools`
- [x] **Format**: Comma-separated list of tool names or regex patterns.
- [x] **Limits**:
    - Max 100 tool entries per session (configurable via `MCP4_TOOL_FILTER_SESSION_MAX_TOOLS`, default 100).
    - Max 255 chars per tool name or regex pattern.
- [x] **Regex syntax**: Patterns are prefixed with `regex:` to distinguish from exact tool names.
    - Example: `X-Mcp4-Tools: get_user, list_users, regex:read_.*`
    - **Auto-anchoring**: Regex patterns without `^`/`$` are automatically anchored (e.g., `regex:user` becomes `^user$`).
    - Note: Env var names already contain `_REGEX` suffix, so no `regex:` prefix is needed there.
- [x] **Validation**:
    - Allow generic whitespace around commas.
    - Validate regex syntax (fail session init if invalid).
    - Apply ReDoS protection (max length 100 chars per pattern, reject nested quantifiers).
    - Enforce entry count limit and per-entry length limit.
- [x] **Composite Tool Syntax**: Include `_allow_list` and/or `_allow_read` keywords to allow composite tools without naming them explicitly.
    - Example: `X-Mcp4-Tools: manage_merge_request, _allow_read` allows `manage_merge_request` plus all read-type composites.

### Session Logic
- [x] Filter is extracted from the `initialize` request.
- [x] Persisted in `SessionData` alongside `filtering` (parameter filters).
- [x] **Pre-computed Allowlist**: Build a Set of allowed tool names at session init (facade pattern) to avoid re-filtering on every `listTools`/`callTool` request. Store both exact names and compiled regex patterns.
- [x] **Immutability**:
    - If header is sent on subsequent requests, it must match the initial session value exactly.
    - If mismatch, throw `ValidationError: X-Mcp4-Tools header mismatch for existing session. Expected: [original], Got: [new].`
- [x] **No-op Detection**: If header filter doesn't change the tool set, reject with `ValidationError: X-Mcp4-Tools filter has no effect for this session. Available tools: N, after filter: N. Check patterns.`
- [x] If header filtering removes every tool, reject initialization with `ValidationError: X-Mcp4-Tools filtered out all tools (original: N). Removed by: [list patterns]. Check session filter configuration.`
- [x] **Entry Count Validation**: If header contains more than `MCP4_TOOL_FILTER_SESSION_MAX_TOOLS` entries (default 100), reject with `ValidationError: X-Mcp4-Tools contains too many entries (N > 100). Reduce to 100 or configure MCP4_TOOL_FILTER_SESSION_MAX_TOOLS.`
- [x] **Length Validation**: If any tool name or pattern exceeds 255 chars, reject with `ValidationError: X-Mcp4-Tools entry exceeds 255 chars: '...' (N chars).`
- [x] **Filters only restrict**: Session headers can only narrow the tool set left after global filters. Tools removed by global env filters cannot be recovered by session headers.

### Enforcement in `McpServer`
- [x] **`tools/list`**:
    - Use pre-computed session allowlist (Set lookup: O(1)) to filter returned tools.
    - Client only sees tools they are allowed to use.
- [x] **`tools/call`**:
    - Check session allowlist before execution (O(1) Set lookup).
    - If tool exists in profile but is blocked by session filter, throw `AuthorizationError: Tool 'X' not allowed in this session. Check X-Mcp4-Tools filter.`
    - If tool was removed by global filter, throw `ResourceNotFoundError: Tool 'X' does not exist.` (no mention of filtering to avoid information disclosure).
- [x] **Composite Tools**:
    - If the filter includes `_allow_list` or `_allow_read` keywords, automatically allow composite tools detected as list or read operations without requiring explicit naming.
    - If composite step references a filtered sub-tool, fail at validation time (not mid-execution) with `ConfigurationError: Composite tool 'X' step 'Y' calls filtered tool 'Z'. Add 'Z' to filter or include _allow_list/_allow_read if Z is in list/read operations and you want them all.`

### Observability & Metrics
- [x] **Structured Logging** (JSON format with correlation IDs):
    - At startup: Log original tool count, filter config, surviving tools (DEBUG level).
    - Per filter application: `{"level":"info","filter_source":"env|session","filter_type":"allow_list|deny_regex|...","tool":"X","action":"removed|allowed","reason":"..."}`.
    - On session init: Log session ID, original vs filtered tool count, applied patterns.
- [x] **Prometheus Metrics**:
    - `mcp4_tools_total{source="profile"}` - Original tool count from profile.
    - `mcp4_tools_filtered{source="global_env",action="allowed|denied"}` - Tools after global filter.
    - `mcp4_tools_session{session_id="..."}` - Per-session tool count (cardinality limit: 1000 sessions).
    - `mcp4_tool_filter_rejections_total{tool="X",source="env|session"}` - Counter of blocked `callTool` attempts per tool.
    - `mcp4_tool_filter_patterns{type="allow_regex|deny_list|..."}` - Gauge of active filter patterns per type.
- [x] **Warning Thresholds**:
    - Env var `MCP4_TOOL_FILTER_WARN_THRESHOLD_PCT` (default: 90) - Warn if more than N% of tools are filtered out.
    - Calculation: `percentage_filtered = ((original_count - surviving_count) / original_count) * 100`
    - Original count: Total tools after profile load, before any filtering.
    - Surviving count: Tools remaining after filter, including composite tools auto-allowed via `_allow_list`/`_allow_read` keywords.
    - Log: `{"level":"warn","msg":"Tool filter removed X% of tools","original":N,"surviving":M,"threshold_pct":90,"removed_count":N-M}`.
- [x] **Attribution in Errors**: All error messages include which filter source (global env vs session header) and specific pattern caused rejection.

## Implementation Steps

### 1. Global Filtering (Env Vars)
- [x] **Create `src/tool-filter.ts`** (new module, separate concern from ProfileLoader per SRP):
    - Export `parseToolFilterConfig(env: NodeJS.ProcessEnv): ToolFilterConfig` - parse env vars, validate regex, auto-anchor patterns, ReDoS protection.
    - Export `applyToolFilter(tools: Tool[], config: ToolFilterConfig): ToolFilterResult` where `ToolFilterResult = {allowed: Tool[], removed: Tool[], reasons: Map<string, string>}`.
    - Export `detectListReadOperations(tool: Tool): {isList: boolean, isRead: boolean}` - reusable logic for `_allow_list`/`_allow_read` detection.
    - Export `validateRegexPattern(pattern: string): {valid: boolean, error?: string}` - ReDoS check using `safe-regex` or similar.
    - Co-locate `src/tool-filter.test.ts` with comprehensive unit tests.
- [x] **Integrate in `src/mcp-server.ts`**:
    - After profile load, call `parseToolFilterConfig(process.env)`.
    - Call `applyToolFilter(profile.tools, config)` if config exists.
    - Update `profile.tools` with `result.allowed`.
    - Log removed tools at DEBUG level with reasons.
    - Update Prometheus `mcp4_tools_filtered` metric.
    - Throw `ConfigurationError` on no-op or all-filtered scenarios with detailed context.

### 2. Transport & Session Updates
- [x] Modify `src/types/http-transport.ts`:
    - Add `toolFilter?: { allowedToolNames: Set<string>, patterns: {allow: RegExp[], deny: RegExp[]}, originalHeader: string }` to `SessionData`.
- [x] Modify `src/http-transport.ts`:
    - Validate entry count (max configurable via `MCP4_TOOL_FILTER_SESSION_MAX_TOOLS`, default 100), individual entry length (max 255 chars).
    - Parse `X-Mcp4-Tools` header, split by comma, trim whitespace.
    - Parse `regex:` prefix, apply auto-anchoring for patterns without `^`/`$`.
    - Validate regex patterns (ReDoS protection), compile and store.
    - Build pre-computed Set of allowed tool names (facade optimization).
    - Store original header string for immutability checks.
    - Enforce header consistency on subsequent requests.
    - Implement no-op detection at session init.

### 3. Server Enforcement
- [x] Modify `src/mcp-server.ts`:
    - Inject session context (if available) into `listTools`.
    - Use pre-computed `allowedToolNames` Set for O(1) filtering in `listTools`.
    - Validate `callTool` against session allowlist (O(1) Set lookup).
    - Distinguish global vs session filter rejections in error messages.
    - Validate composite tool dependencies at session init (fail fast if step references filtered tool).
    - Handle `_allow_list` and `_allow_read` keywords for composite tools.

### 4. Tests
**Unit Tests:**
- [x] `isToolAllowed` logic with mixed allow/deny/regex patterns.
- [x] Auto-anchoring: `user` → `^user$`, `.*user.*` stays functionally unchanged because of `^.*user.*$` equivalence, `^user` → `^user$`.
- [x] ReDoS pattern rejection: `(a+)+b`, nested quantifiers, excessive length.
- [x] Case sensitivity: `GetUser` ≠ `getuser`.
- [x] No-op detection: filter that doesn't change tool set.
- [x] Composite tool keyword handling: `_allow_list`, `_allow_read`.

**Integration Tests (Global Env Filter):**
- [x] Server startup with `MCP4_TOOL_FILTER_ALLOW_LIST=get_user,list_users` - verify only those tools exist.
- [x] Server startup with `MCP4_TOOL_FILTER_ALLOW_REGEX=get.*` - verify regex matching.
- [x] Server startup with `MCP4_TOOL_FILTER_DENY_LIST=delete_user` - verify exclusion.
- [x] Server startup with no-op filter - verify failure with detailed error.
- [x] Server startup with filter removing all tools - verify failure with tool count in error.
- [x] Metrics validation: check `mcp4_tools_total`, `mcp4_tools_filtered` counts.

**Integration Tests (Session Header Filter):**
- [x] `listTools` with `X-Mcp4-Tools: get_user, list_users` - returns only those tools.
- [x] `listTools` with `X-Mcp4-Tools: regex:read_.*` - returns matching tools.
- [x] `callTool` for allowed tool - succeeds.
- [x] `callTool` for session-filtered tool - throws `AuthorizationError` with session attribution.
- [x] `callTool` for globally-filtered tool - throws `ResourceNotFoundError` (no filter mention).
- [x] Session init with no-op header - fails with detailed error.
- [x] Session init with all-tools-filtered header - fails with tool count.
- [x] Header immutability: subsequent request with different header - throws `ValidationError`.
- [x] Composite tool with `_allow_read` - allowed without explicit naming.
- [x] Composite step referencing filtered sub-tool - fails at validation with explicit error.

**Edge Cases:**
- [x] Global filter allows 10 tools, session header requests 5, only 3 overlap - returns 3 (intersection logic, no special handling needed).
- [x] Unicode tool names: `读取用户` - normalize all tool names using `String.prototype.normalize('NFC')` at profile load and filter parsing to handle Unicode composition variants (`café` vs `cafe\u0301`). Regex matching works correctly with Unicode by default. Test both exact match and regex patterns with Unicode.
- [x] Very long tool names: max 255 chars per entry enforced. Test rejection of `X-Mcp4-Tools: very_long_tool_name_with_256_or_more_characters...` with specific error. Note: agents typically struggle with >64 tools in a single session.
- [x] Too many tool entries: max 100 entries (configurable via `MCP4_TOOL_FILTER_SESSION_MAX_TOOLS`). Test rejection of header with 101+ entries (default) with specific error.
- [x] Special chars in tool names: `tool-name_v2`, `tool.name` - allowed by MCP definition and matched correctly test it.
- [x] Empty header: `X-Mcp4-Tools:` - caught by no-op detection, test it.
- [x] Regex with typo matching zero tools - caught by no-op detection, test it.

### 5. Documentation Updates
- [x] Update `README.md` with `MCP4_TOOL_FILTER_*` env var descriptions.
- [x] Update `docs/HTTP-TRANSPORT.md` with `X-Mcp4-Tools` header format, examples, and composite tool keywords.
- [x] Document auto-anchoring behavior and ReDoS protections.
- [x] Add troubleshooting section for common filter misconfigurations.
- [x] Update `env.example` with tool filter variables.
