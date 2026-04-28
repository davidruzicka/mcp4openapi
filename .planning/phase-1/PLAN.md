---
phase: phase-1
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - scripts/run-implementor.ts
  - src/automation/implementor-codex.ts
  - scripts/run-implementor.test.ts
  - package.json
  - .github/workflows/implementor.yml
  - CHANGELOG.md
autonomous: true
requirements:
  - IMPL-FALLBACK-01
  - IMPL-FALLBACK-02
  - IMPL-FALLBACK-03
  - CODEX-CACHE-01

must_haves:
  truths:
    - "When the primary implementor command throws (process-level failure), the fallback command is attempted before reporting outcome: failed"
    - "When the primary command returns outcome: failed in JSON, no fallback is attempted"
    - "When the primary command returns outcome: blocked in JSON, no fallback is attempted"
    - "When IMPLEMENTOR_FALLBACK_COMMAND is unset or empty, behavior is identical to today"
    - "When both primary and fallback fail at process level, the fallback error is reported"
    - "@openai/codex is installed via npm ci (devDependencies) rather than a separate global install step"
    - "IMPLEMENTOR_CODEX_BIN defaults to ./node_modules/.bin/codex"
  artifacts:
    - path: "scripts/run-implementor.ts"
      provides: "runImplementorCommandWithFallback() function"
      contains: "IMPLEMENTOR_FALLBACK_COMMAND"
    - path: "scripts/run-implementor.test.ts"
      provides: "Unit tests for fallback routing logic"
      exports: ["describe", "it"]
    - path: "src/automation/implementor-codex.ts"
      provides: "Updated IMPLEMENTOR_CODEX_BIN default"
      contains: "./node_modules/.bin/codex"
    - path: "package.json"
      provides: "@openai/codex in devDependencies"
      contains: "@openai/codex"
    - path: ".github/workflows/implementor.yml"
      provides: "Workflow with IMPLEMENTOR_FALLBACK_COMMAND env var, no separate Install Codex step"
  key_links:
    - from: "scripts/run-implementor.ts (line 130)"
      to: "runImplementorCommandWithFallback()"
      via: "replaces direct runImplementorCommand call"
      pattern: "runImplementorCommandWithFallback"
    - from: "runImplementorCommandWithFallback"
      to: "runImplementorCommand (fallback path)"
      via: "catch on execFileAsync throw, re-throw when fallbackCommand absent"
      pattern: "fallbackCommand.*runImplementorCommand"
    - from: ".github/workflows/implementor.yml"
      to: "vars.IMPLEMENTOR_FALLBACK_COMMAND"
      via: "env block on Run implementor handoff step"
      pattern: "IMPLEMENTOR_FALLBACK_COMMAND"
---

<objective>
Add IMPLEMENTOR_FALLBACK_COMMAND support to the implementor pipeline so that process-level backend failures (crash, rate limit, binary not found) attempt a second command before reporting outcome: failed. Bundle the Codex caching optimization that moves @openai/codex into devDependencies, eliminating the uncached global install on every hourly run.

Purpose: Increase implementor pipeline resilience when the primary AI backend is unavailable without changing successful-run or blocked-run behavior.
Output: Updated run-implementor.ts with fallback routing, unit tests, updated workflow, updated package.json, updated implementor-codex.ts default, CHANGELOG entry.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phase-1/CONTEXT.md

@scripts/run-implementor.ts
@src/automation/implementor-codex.ts
@.github/workflows/implementor.yml
@package.json

<interfaces>
<!-- Key contracts extracted from codebase. Executor should use these directly. -->

From src/automation/implementor-runner.ts (exports used by run-implementor.ts):
```typescript
export type ImplementorCommandResult = {
  outcome: 'pr-created' | 'failed' | 'blocked';
  summary: string;
  pullRequest?: { number: number; url: string };
};
export function parseImplementorCommandResult(raw: string): ImplementorCommandResult;
```

From scripts/run-implementor.ts (existing helper to wrap):
```typescript
async function runImplementorCommand(command: string, payload: unknown): Promise<ImplementorCommandResult>
// Runs: execFileAsync('bash', ['-lc', command], { env: { ...process.env, IMPLEMENTOR_TASK_JSON: JSON.stringify(payload) }, maxBuffer: 2*1024*1024 })
// Parses stdout via parseImplementorCommandResult
// Throws when execFileAsync throws (process-level failure)
```

Discriminator for fallback trigger:
- execFileAsync THROWS   -> process-level failure  -> TRY fallback
- result.outcome === 'failed'  -> agent tried, gave up -> NO fallback
- result.outcome === 'blocked' -> policy block         -> NO fallback
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement runImplementorCommandWithFallback in run-implementor.ts and update IMPLEMENTOR_CODEX_BIN default</name>
  <files>scripts/run-implementor.ts, src/automation/implementor-codex.ts</files>
  <behavior>
    - runImplementorCommandWithFallback(primary, fallback|undefined, payload):
      - Calls runImplementorCommand(primary, payload)
      - If it RESOLVES (any outcome including 'failed'/'blocked') -> return result unchanged, no fallback
      - If it THROWS and fallback is undefined/empty -> re-throw (preserves today's catch-to-failed behavior at call site)
      - If it THROWS and fallback is a non-empty string -> call runImplementorCommand(fallback, payload); propagate whatever that returns or throws
    - The existing call site in the assignment loop (line 130) replaces `runImplementorCommand(implementorCommand, taskPayload)` with `runImplementorCommandWithFallback(implementorCommand, fallbackCommand, taskPayload)` where `fallbackCommand = process.env.IMPLEMENTOR_FALLBACK_COMMAND?.trim() || undefined`
    - In src/automation/implementor-codex.ts: change default for IMPLEMENTOR_CODEX_BIN from `'codex'` to `'./node_modules/.bin/codex'` at line 46
  </behavior>
  <action>
    In scripts/run-implementor.ts:

    1. After the `implementorCommand` guard block (lines 39-43), read the fallback:
       ```typescript
       const implementorFallbackCommand = process.env.IMPLEMENTOR_FALLBACK_COMMAND?.trim() || undefined;
       ```

    2. Add a new function `runImplementorCommandWithFallback` below the existing `runImplementorCommand` function:
       ```typescript
       async function runImplementorCommandWithFallback(
         primaryCommand: string,
         fallbackCommand: string | undefined,
         payload: unknown,
       ): Promise<ImplementorCommandResult> {
         try {
           return await runImplementorCommand(primaryCommand, payload);
         } catch (primaryError: unknown) {
           if (!fallbackCommand) {
             throw primaryError;
           }
           return await runImplementorCommand(fallbackCommand, payload);
         }
       }
       ```
       The function must NOT catch outcomes - only execFileAsync throws reach the catch block because runImplementorCommand itself does not catch. Outcome-level results (failed, blocked) are returned values, not thrown errors, so they naturally bypass the catch.

    3. At the existing call site (approximately line 130), replace:
       ```typescript
       return await runImplementorCommand(implementorCommand, taskPayload).catch(...)
       ```
       with:
       ```typescript
       return await runImplementorCommandWithFallback(implementorCommand, implementorFallbackCommand, taskPayload).catch(...)
       ```
       The `.catch(...)` wrapper at the call site is kept as-is - it converts any unhandled throws (primary throws with no fallback, or fallback also throws) into `{ outcome: 'failed', summary: ... }`.

    In src/automation/implementor-codex.ts line 46, change:
    ```typescript
    const command = input.env.IMPLEMENTOR_CODEX_BIN?.trim() || 'codex';
    ```
    to:
    ```typescript
    const command = input.env.IMPLEMENTOR_CODEX_BIN?.trim() || './node_modules/.bin/codex';
    ```
  </action>
  <verify>
    <automated>npm run typecheck</automated>
  </verify>
  <done>
    - runImplementorCommandWithFallback exported or defined in scripts/run-implementor.ts
    - IMPLEMENTOR_FALLBACK_COMMAND read from env at startup
    - IMPLEMENTOR_CODEX_BIN default is './node_modules/.bin/codex'
    - npm run typecheck passes with zero errors
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Write unit tests for fallback routing in scripts/run-implementor.test.ts</name>
  <files>scripts/run-implementor.test.ts</files>
  <behavior>
    Tests cover the five required scenarios using vi.mock to intercept execFileAsync (or by extracting and unit-testing runImplementorCommandWithFallback directly if it is exported). Because the function lives in a top-level script (not a module with clean exports), prefer extracting it to a thin helper module OR testing via mocking the child_process execFile. Use the same pattern as scripts/github-agent-runtime.test.ts for test file structure.

    Required test cases (all within describe('runImplementorCommandWithFallback')):
    1. "calls fallback when primary command throws at process level"
       - primary: rejects with Error('ENOENT binary not found')
       - fallback: resolves with { outcome: 'pr-created', summary: '...', pullRequest: { number: 1, url: '...' } }
       - expected: result equals fallback result
    2. "does NOT call fallback when primary returns outcome: failed"
       - primary: resolves with { outcome: 'failed', summary: 'agent gave up' }
       - fallback: a spy that must NOT be called
       - expected: result equals { outcome: 'failed', summary: 'agent gave up' }
    3. "does NOT call fallback when primary returns outcome: blocked"
       - primary: resolves with { outcome: 'blocked', summary: 'policy block' }
       - fallback: a spy that must NOT be called
       - expected: result equals { outcome: 'blocked', summary: 'policy block' }
    4. "re-throws primary error when no fallback is configured"
       - primary: rejects with Error('rate limited')
       - fallback: undefined
       - expected: runImplementorCommandWithFallback rejects with the same error
    5. "reports fallback error when fallback also fails at process level"
       - primary: rejects with Error('primary crashed')
       - fallback: rejects with Error('fallback also crashed')
       - expected: runImplementorCommandWithFallback rejects with Error('fallback also crashed')

    Implementation note: If runImplementorCommandWithFallback is not exported from run-implementor.ts (it is a top-level script), extract the function to a new file `scripts/implementor-fallback.ts` (or add an export) so tests can import it directly. Adjust Task 1 accordingly by moving the function there and importing it in run-implementor.ts.
  </behavior>
  <action>
    1. If needed, refactor: move `runImplementorCommandWithFallback` (and if convenient, `runImplementorCommand`) to `scripts/implementor-fallback.ts` with named exports. Update `scripts/run-implementor.ts` to import from `./implementor-fallback.js`.

    2. Create `scripts/run-implementor.test.ts` following the pattern of `scripts/github-agent-runtime.test.ts`:
       - Use `vi.mock` or inject the inner `runImplementorCommand` as a parameter to keep tests pure
       - Import `runImplementorCommandWithFallback` from `./implementor-fallback.js` (or wherever it lives after step 1)
       - Each test: set up mocks, call the function, assert outcome

    3. Preferred approach (avoids complex mock setup): define `runImplementorCommandWithFallback` to accept an optional `_runCommand` parameter (defaulting to the real `runImplementorCommand`) so tests can inject a stub:
       ```typescript
       export async function runImplementorCommandWithFallback(
         primaryCommand: string,
         fallbackCommand: string | undefined,
         payload: unknown,
         _runCommand = runImplementorCommand,
       ): Promise<ImplementorCommandResult>
       ```
       This is the cleanest testable design without requiring complex ESM mocking.

    4. Run tests after writing to confirm all 5 pass.
  </action>
  <verify>
    <automated>npm test -- -t "runImplementorCommandWithFallback"</automated>
  </verify>
  <done>
    - scripts/run-implementor.test.ts exists with 5 test cases
    - All 5 cases pass: fallback triggered on throw, not triggered on failed/blocked, re-throw when no fallback, fallback error propagated
    - npm run typecheck passes
  </done>
</task>

<task type="auto">
  <name>Task 3: Update package.json, workflow, and CHANGELOG</name>
  <files>package.json, .github/workflows/implementor.yml, CHANGELOG.md</files>
  <action>
    In package.json - devDependencies section, add:
    ```json
    "@openai/codex": "^0.116.0"
    ```
    Insert in alphabetical order relative to existing devDependency keys.

    In .github/workflows/implementor.yml:
    1. Remove the entire "Install Codex CLI" step (lines 53-54):
       ```yaml
       - name: Install Codex CLI
         run: npm install -g @openai/codex
       ```
    2. In the env block of "Run implementor handoff" step, add after the IMPLEMENTOR_COMMAND line:
       ```yaml
       IMPLEMENTOR_FALLBACK_COMMAND: ${{ vars.IMPLEMENTOR_FALLBACK_COMMAND }}
       ```

    In CHANGELOG.md, prepend a new entry to the [Unreleased] section (or create it if absent).
    Use a single-line entry per AGENTS.md style:
    ```markdown
    ### Changed
    - Implementor pipeline now attempts IMPLEMENTOR_FALLBACK_COMMAND on process-level backend failures; @openai/codex moved to devDependencies for cached installs.
    ```

    Note: Do NOT run `npm install` after editing package.json - the lock file update is a separate concern for the implementor to decide. Only the package.json edit is required here.
  </action>
  <verify>
    <automated>npm run typecheck</automated>
  </verify>
  <done>
    - package.json devDependencies contains "@openai/codex": "^0.116.0"
    - .github/workflows/implementor.yml has IMPLEMENTOR_FALLBACK_COMMAND in env block and no "Install Codex CLI" step
    - CHANGELOG.md has entry describing the fallback command and caching optimization
    - npm run typecheck passes
  </done>
</task>

</tasks>

<verification>
After all tasks complete, run the full test suite to confirm no regressions:

```bash
npm test
```

Verify the workflow file is syntactically valid:
```bash
node -e "const yaml = require('js-yaml'); yaml.load(require('fs').readFileSync('.github/workflows/implementor.yml', 'utf8')); console.log('OK')" 2>/dev/null || npx js-yaml .github/workflows/implementor.yml
```

Spot-check the fallback is wired end-to-end:
```bash
grep -n "IMPLEMENTOR_FALLBACK_COMMAND\|runImplementorCommandWithFallback" scripts/run-implementor.ts
grep -n "IMPLEMENTOR_FALLBACK_COMMAND" .github/workflows/implementor.yml
grep -n "node_modules/.bin/codex" src/automation/implementor-codex.ts
grep -n "@openai/codex" package.json
```
</verification>

<success_criteria>
1. IMPLEMENTOR_FALLBACK_COMMAND env var is read in run-implementor.ts and passed to runImplementorCommandWithFallback
2. Fallback is attempted only on process-level throws from execFileAsync, not on outcome: failed or outcome: blocked
3. When fallback is absent, existing behavior is preserved (throw propagates to outer .catch -> outcome: failed)
4. When both primary and fallback throw, the fallback error is what propagates
5. @openai/codex is in devDependencies at ^0.116.0
6. "Install Codex CLI" step is removed from implementor.yml
7. IMPLEMENTOR_FALLBACK_COMMAND appears in the workflow env block
8. IMPLEMENTOR_CODEX_BIN default is ./node_modules/.bin/codex
9. All 5 new unit tests pass
10. npm test passes (no regressions in existing implementor-runner and implementor-codex tests)
11. npm run typecheck passes
</success_criteria>

<output>
After completion, create `.planning/phase-1/phase-1-01-SUMMARY.md` with:
- What was implemented (fallback routing function, test file, workflow and package.json changes)
- Key decisions made (e.g., whether runImplementorCommandWithFallback was extracted to a separate module)
- Files modified and their roles
- Test outcomes
</output>
