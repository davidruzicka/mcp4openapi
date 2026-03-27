# Phase 1: Implementor Fallback Command

## Goal

Add `IMPLEMENTOR_FALLBACK_COMMAND` support to the implementor pipeline so that when the primary backend (Codex) fails at the process level (API unavailable, rate limit, binary error), a fallback command is attempted before reporting `outcome: failed`.

## Background (from design discussion)

The implementor pipeline currently has a single point of failure:
- `.github/workflows/implementor.yml` installs `@openai/codex` globally via `npm install -g` on every hourly run (not cached)
- `scripts/run-implementor.ts` calls `IMPLEMENTOR_COMMAND` (default: `node dist/scripts/run-implementor-codex.js`)
- Any process-level failure (exit code != 0, timeout, rate limit) results in `outcome: failed` with no retry on a different backend

## Key Design Decisions

### When to trigger fallback
- **YES**: Process-level failure - `execFileAsync` throws (Codex crashes, rate limited, binary not found)
- **NO**: `outcome: 'failed'` returned in JSON - agent tried but couldn't complete the task (same issue, different backend likely fails too)
- **NO**: `outcome: 'blocked'` - policy block, not an infrastructure issue

### New env var: `IMPLEMENTOR_FALLBACK_COMMAND`
- Optional, mirrors `IMPLEMENTOR_COMMAND` semantics
- If empty/unset, behavior is identical to today
- Added to `implementor.yml` from `vars.IMPLEMENTOR_FALLBACK_COMMAND`

### Codex caching optimization (bundled)
- Move `@openai/codex` from `npm install -g` (uncached, runs every hour) to `devDependencies`
- Leverages existing `cache: 'npm'` on `actions/setup-node` step
- Update `IMPLEMENTOR_CODEX_BIN` default from `'codex'` to `'./node_modules/.bin/codex'`
- Remove "Install Codex CLI" workflow step

## Files to Modify

| File | Change |
|------|--------|
| `scripts/run-implementor.ts` | Add `runImplementorCommandWithFallback()`, read `IMPLEMENTOR_FALLBACK_COMMAND` |
| `src/automation/implementor-runner.ts` | No change expected (logic stays in script layer) |
| `.github/workflows/implementor.yml` | Add `IMPLEMENTOR_FALLBACK_COMMAND` env var, remove Install Codex step |
| `package.json` | Add `@openai/codex` to devDependencies |
| `src/automation/implementor-codex.ts` | Update `IMPLEMENTOR_CODEX_BIN` default |
| `CHANGELOG.md` | Add entry |

## Tests Required

- Fallback triggered when primary command throws (process crash)
- Fallback NOT triggered when primary returns `outcome: 'failed'`
- Fallback NOT triggered when primary returns `outcome: 'blocked'`
- No fallback configured: behavior identical to today (throws propagated)
- Fallback also fails: error from fallback is reported

## Acceptance Criteria

1. `IMPLEMENTOR_FALLBACK_COMMAND` env var accepted and used when primary command fails at process level
2. Fallback does NOT trigger on `outcome: failed` or `outcome: blocked`
3. `@openai/codex` in devDependencies, no separate install step in workflow
4. All existing implementor tests pass
5. New tests cover success and failure paths for fallback logic
6. `npm run typecheck` passes
