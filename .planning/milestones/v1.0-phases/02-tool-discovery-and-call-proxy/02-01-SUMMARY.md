---
phase: 02-tool-discovery-and-call-proxy
plan: 01
subsystem: upstream
tags: [mcp, tool-sanitizer, notification-queue, profile-validation, security, typescript]

# Dependency graph
requires:
  - phase: 01-upstream-session-foundation
    provides: upstream error types, upstream module structure, profile loader patterns
provides:
  - sanitizeToolList function with data-driven allowlists (SEC-01)
  - NotificationQueue class with bounded size and TTL eviction (REL-04)
  - Profile mutual-exclusivity validation for upstream_mcp + tools (D-02)
affects: [02-02-tool-discovery-handler, 02-03-notification-forwarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Data-driven validation constants (not if/else chains) for tool sanitizer rules"
    - "Truncate unsafe inputs to max length before logging to prevent log injection"
    - "Use Date.now() not entry.timestamp for wall-clock TTL eviction"
    - "TDD: RED (failing test) -> GREEN (implementation) -> commit per task"

key-files:
  created:
    - src/upstream/upstream-tool-sanitizer.ts
    - src/upstream/upstream-tool-sanitizer.test.ts
    - src/upstream/upstream-notification-queue.ts
    - src/upstream/upstream-notification-queue.test.ts
  modified:
    - src/profile/profile-loader.ts
    - src/profile/profile-loader.test.ts
    - CHANGELOG.md

key-decisions:
  - "Truncate dropped tool names to 100 chars in SanitizationResult.dropped and in logger.warn to prevent log injection of maliciously long upstream tool names"
  - "TTL eviction in NotificationQueue uses Date.now() (wall-clock), not entry.timestamp, so correct under clock skew and non-current timestamps"
  - "Mutual-exclusivity check placed after resolveUpstreamMcpConfig so env-sourced upstream_mcp config is resolved before the check fires"

patterns-established:
  - "upstream-tool-sanitizer.ts: data-driven TOOL_NAME_PATTERN, DESCRIPTION_FORBIDDEN_CHARS constants; ordered validation checks (length, pattern, desc length, desc chars)"
  - "upstream-notification-queue.ts: bounded push with TTL filter then size evict; drain returns copy and resets"

requirements-completed: [SEC-01, REL-04, PROXY-03]

# Metrics
duration: 4min
completed: 2026-03-30
---

# Phase 02 Plan 01: Tool Sanitizer, Notification Queue, and Profile Mutual-Exclusivity Validation Summary

**Tool name/description sanitizer with injection-safe logging, bounded TTL notification queue, and load-time profile conflict detection for upstream_mcp + tools[].**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-30T13:51:25Z
- **Completed:** 2026-03-30T13:55:11Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- `sanitizeToolList` drops tools with names outside `[a-zA-Z0-9_-]` (max 255 chars) or descriptions with `<`, `>`, backtick (max 2048 chars); truncates dropped names to 100 chars to prevent log injection; 18 tests including exact boundary cases
- `NotificationQueue` buffers upstream notifications with configurable size cap (default 50) and TTL (default 5 min); TTL eviction uses `Date.now()` not `entry.timestamp`; reusable across drain cycles; 13 tests including fake-timer TTL test
- Profile loader rejects profiles defining both `upstream_mcp` and non-empty `tools[]` with a `ValidationError` containing "mutually exclusive"; check runs after `resolveUpstreamMcpConfig`

## Task Commits

1. **Task 1: Tool sanitizer module with data-driven allowlists (SEC-01)** - `4b467a4` (feat)
2. **Task 2: Bounded notification queue with size and TTL eviction (REL-04)** - `fde6767` (feat)
3. **Task 3: Profile mutual-exclusivity validation for upstream_mcp + tools (D-02)** - `aa57ce2` (feat)
4. **CHANGELOG update** - `85b50db` (chore)

## Files Created/Modified
- `src/upstream/upstream-tool-sanitizer.ts` - sanitizeToolList with data-driven allowlists and log-injection-safe dropped name truncation
- `src/upstream/upstream-tool-sanitizer.test.ts` - 18 unit tests including boundary cases at 2048/2049 chars and 100-char name truncation
- `src/upstream/upstream-notification-queue.ts` - NotificationQueue class with push/drain/size; bounded by maxSize and TTL using wall-clock eviction
- `src/upstream/upstream-notification-queue.test.ts` - 13 unit tests including fake-timer TTL wall-clock verification
- `src/profile/profile-loader.ts` - D-02 mutual-exclusivity check after resolveUpstreamMcpConfig
- `src/profile/profile-loader.test.ts` - 3 tests for mutual-exclusivity: both fields rejects, upstream_mcp-only passes, tools-only passes
- `CHANGELOG.md` - user-facing entries for all three deliverables

## Decisions Made
- Truncate dropped tool names to 100 chars in both `SanitizationResult.dropped` and the logger warn call to prevent log injection via maliciously crafted upstream tool names
- `NotificationQueue` TTL eviction uses `Date.now()` not `entry.timestamp` - correct under clock skew and when incoming entry has a non-current timestamp
- Mutual-exclusivity check placed after `resolveUpstreamMcpConfig` so env-sourced `upstream_mcp_from_env` config is resolved before the check fires

## Deviations from Plan

**1. [Rule 2 - Missing Critical] Added test fixture correction for actual UpstreamMcpServerConfig schema**
- **Found during:** Task 3 (mutual-exclusivity validation tests)
- **Issue:** Plan's `<interfaces>` snippet showed `{ name, url }` shorthand but actual `UpstreamMcpServerConfig` requires `transport: { type, url }` as a required nested object; also `tools` is a required field on Profile (cannot be omitted)
- **Fix:** Updated test fixture to use correct schema: `transport: { type: 'http-streamable', url: '...' }` and `tools: []` for the upstream-only test
- **Files modified:** src/profile/profile-loader.test.ts
- **Verification:** Tests pass with correct schema
- **Committed in:** aa57ce2 (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 - missing critical schema correctness)
**Impact on plan:** Necessary schema correction, no scope creep.

## Issues Encountered
None beyond the schema deviation above.

## Known Stubs
None - all deliverables are complete implementations with full test coverage.

## Next Phase Readiness
- `sanitizeToolList` is ready to be imported in Plan 02 (tools/list handler wiring) at the upstream tools/list response processing step
- `NotificationQueue` is ready to be used in Plan 03 (notification forwarding) in the `UpstreamConnectionManager` notification handler
- Profile mutual-exclusivity validation is wired and active; profiles with both fields will fail at load time

---
## Self-Check: PASSED

All files verified present. All commits verified in git log.

*Phase: 02-tool-discovery-and-call-proxy*
*Completed: 2026-03-30*
