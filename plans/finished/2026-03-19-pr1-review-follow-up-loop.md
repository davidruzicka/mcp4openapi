# PR1 Review Follow-up Loop Implementation Plan

> **For Hermes:** Use the subagent-driven-development skill to execute this plan task-by-task.

**Goal:** Implement one cohesive PR that turns PR review feedback into machine-readable follow-up work, tracks per-head review resolution state, and lets the planner emit a structured review-follow-up artifact consumable by the implementor.

**Architecture:** Add three small shared modules under `src/automation/` instead of growing runner-specific heuristics: `review-follow-up.ts` for actionable thread extraction and reply planning, `review-resolution-state.ts` for current-head state classification, and `planner-artifact.ts` for a typed planner handoff artifact. Keep runners thin: reviewer produces artifacts, merger evaluates shared resolution state, planner emits a machine-readable artifact, and implementor consumes artifacts plus publishes thread replies.

**Tech Stack:** TypeScript, Vitest, GitHub REST + GraphQL runner scripts, existing agent metadata blocks in `src/automation/agent-feedback.ts`, existing runtime helpers in `scripts/github-agent-runtime.ts`.

---

## Canonical references to review before editing

- `docs/AUTONOMOUS-AGENTS.md`
- `docs/roadmaps/agent-development-support.md`
- `src/automation/reviewer-runner.ts`
- `src/automation/merger-runner.ts`
- `src/automation/planner-runner.ts`
- `src/automation/implementor-runner.ts`
- `scripts/run-reviewer.ts`
- `scripts/run-implementor.ts`
- `scripts/run-planner.ts`
- `scripts/github-agent-runtime.ts`

## Scope boundary for this PR

In scope:
- actionable review-thread extraction for the current PR head
- shared thread resolution state: `open`, `addressed`, `obsolete`
- merge policy driven by that shared state
- planner artifact for review-driven fix/test handoff
- implementor task payload support for planner artifact + review follow-up items
- implementor thread replies with explicit agent disclosure
- tests for success, stale-head, and fail-closed paths
- docs update in `docs/AUTONOMOUS-AGENTS.md`

Out of scope:
- observability design from `#182`
- human escalation policy from `#183`
- broad workflow redesign outside planner/reviewer/implementor/merger handoff
- generic workflow graph engine

## Proposed files

**Create**
- `src/automation/review-follow-up.ts`
- `src/automation/review-follow-up.test.ts`
- `src/automation/review-resolution-state.ts`
- `src/automation/review-resolution-state.test.ts`
- `src/automation/planner-artifact.ts`
- `src/automation/planner-artifact.test.ts`
- `docs/plans/2026-03-19-pr1-review-follow-up-loop.md` (this file)

**Modify**
- `src/automation/reviewer-runner.ts`
- `src/automation/reviewer-runner.test.ts`
- `src/automation/merger-runner.ts`
- `src/automation/merger-runner.test.ts`
- `src/automation/planner-runner.ts`
- `src/automation/planner-runner.test.ts`
- `src/automation/implementor-runner.ts`
- `src/automation/implementor-runner.test.ts`
- `scripts/run-reviewer.ts`
- `scripts/run-implementor.ts`
- `scripts/run-planner.ts`
- `scripts/github-agent-runtime.ts`
- `docs/AUTONOMOUS-AGENTS.md`

---

## Shared data contracts to introduce first

### `src/automation/review-follow-up.ts`

Create these exported types first:

```ts
export type ReviewFollowUpActionability = 'actionable' | 'informational' | 'obsolete';

export interface ReviewFollowUpItem {
  readonly threadId: string;
  readonly headSha: string;
  readonly sourceCommentId: string;
  readonly summary: string;
  readonly actionability: ReviewFollowUpActionability;
  readonly requiresReply: boolean;
}

export interface ImplementorThreadReplyPlan {
  readonly threadId: string;
  readonly headSha: string;
  readonly body: string;
}
```

### `src/automation/review-resolution-state.ts`

Create these exported types first:

```ts
export type ReviewThreadResolutionState = 'open' | 'addressed' | 'obsolete';

export interface ResolvedReviewThreadState {
  readonly threadId: string;
  readonly headSha: string;
  readonly state: ReviewThreadResolutionState;
  readonly blocking: boolean;
  readonly summary: string;
}
```

### `src/automation/planner-artifact.ts`

Create these exported types first:

```ts
export interface ReviewFixPlanArtifact {
  readonly kind: 'review-follow-up';
  readonly threadId: string;
  readonly headSha: string;
  readonly fixSummary: string;
  readonly implementationSteps: readonly string[];
  readonly testSteps: readonly string[];
  readonly verificationSteps: readonly string[];
}
```

Keep these contracts small and explicit. Avoid optional-field sprawl in the first pass.

---

## Task 1: Add failing tests for actionable review-thread extraction

**Objective:** Lock the exact behavior for current-head actionable follow-up extraction before changing reviewer logic.

**Files:**
- Create: `src/automation/review-follow-up.test.ts`
- Reference: `src/automation/reviewer-runner.test.ts`

**Step 1: Write failing tests for follow-up extraction**

Add tests for:
- current-head unresolved reviewer thread -> one actionable item
- stale-head thread -> no actionable item
- resolved thread with only informational agent metadata -> no actionable item
- duplicate rerun over same thread/comments -> stable identical output

Example skeleton:

```ts
it('extracts one actionable item from a current-head unresolved thread', () => {
  const items = collectReviewFollowUpItems({
    reviewThreads: [buildReviewThread(/* current-head unresolved comments */)],
    currentHeadSha: 'abc123',
  });

  expect(items).toEqual([
    expect.objectContaining({
      threadId: 'thread-1',
      headSha: 'abc123',
      actionability: 'actionable',
      requiresReply: true,
    }),
  ]);
});
```

**Step 2: Run the new test file**

Run:
```bash
npm run test:unit -- src/automation/review-follow-up.test.ts
```

Expected: FAIL because the module does not exist yet.

**Step 3: Create minimal module implementation**

Implement:
- `collectReviewFollowUpItems(...)`
- a tiny summarizer that uses the latest external thread comment body as the summary source
- conservative current-head filtering using agent metadata `head-sha`

**Step 4: Re-run the focused test**

Run:
```bash
npm run test:unit -- src/automation/review-follow-up.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/review-follow-up.ts src/automation/review-follow-up.test.ts
git commit -m "test: add review follow-up extraction coverage"
```

---

## Task 2: Add failing tests for implementor thread reply planning

**Objective:** Define how a successful implementor run maps follow-up items into thread replies.

**Files:**
- Modify: `src/automation/review-follow-up.test.ts`
- Create or modify: `src/automation/review-follow-up.ts`

**Step 1: Add failing tests**

Cover:
- successful implementor result -> one reply plan per actionable item requiring reply
- missing thread metadata -> fail closed
- duplicate actionable items for the same thread -> one deterministic reply plan

Example skeleton:

```ts
it('builds one reply plan per actionable follow-up item', () => {
  const replies = buildImplementorThreadReplyPlans({
    items: [
      {
        threadId: 'thread-1',
        headSha: 'abc123',
        sourceCommentId: 'comment-2',
        summary: 'Add regression coverage for fallback path',
        actionability: 'actionable',
        requiresReply: true,
      },
    ],
    newHeadSha: 'def456',
    resultSummary: 'Added fallback-path regression coverage.',
  });

  expect(replies[0]?.body).toContain('This reply was prepared by an agent.');
  expect(replies[0]?.body).toContain('def456');
});
```

**Step 2: Run the test**

Run:
```bash
npm run test:unit -- src/automation/review-follow-up.test.ts
```

Expected: FAIL.

**Step 3: Implement minimal reply planner**

Reply body requirements:
- short summary of what changed
- explicit new head SHA or commit reference
- explicit agent disclosure
- machine-readable metadata block for future resolution-state lookup

**Step 4: Re-run the focused test**

Run:
```bash
npm run test:unit -- src/automation/review-follow-up.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/review-follow-up.ts src/automation/review-follow-up.test.ts
git commit -m "feat: add implementor review-thread reply planning"
```

---

## Task 3: Add failing tests for shared per-head resolution state

**Objective:** Move thread-state classification out of reviewer/merger heuristics into one shared module.

**Files:**
- Create: `src/automation/review-resolution-state.test.ts`
- Create: `src/automation/review-resolution-state.ts`

**Step 1: Write failing tests**

Cover:
- unresolved current-head thread -> `open`
- current-head thread with implementor follow-up reply -> `addressed`
- thread for old head after new commit -> `obsolete`
- resolved-but-unreplied current-head thread should still classify conservatively

Example skeleton:

```ts
it('classifies a current-head unresolved thread as open', () => {
  const states = resolveReviewThreadStates({
    reviewThreads: [buildReviewThread({ id: 'thread-1', isResolved: false })],
    currentHeadSha: 'abc123',
    implementorReplies: [],
  });

  expect(states).toEqual([
    expect.objectContaining({ threadId: 'thread-1', state: 'open', blocking: true }),
  ]);
});
```

**Step 2: Run the focused test**

Run:
```bash
npm run test:unit -- src/automation/review-resolution-state.test.ts
```

Expected: FAIL.

**Step 3: Implement the minimal resolver**

Suggested decision table:

| Condition | State | Blocking |
| --- | --- | --- |
| thread belongs to current head and still lacks implementor follow-up | `open` | `true` |
| thread belongs to current head and has implementor follow-up metadata for that head | `addressed` | `false` |
| thread metadata points to an older head than current head | `obsolete` | `false` |

Prefer a data-driven helper over nested branch chains.

**Step 4: Re-run the focused test**

Run:
```bash
npm run test:unit -- src/automation/review-resolution-state.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/review-resolution-state.ts src/automation/review-resolution-state.test.ts
git commit -m "test: add shared review resolution state coverage"
```

---

## Task 4: Refactor reviewer runner to use shared follow-up and resolution modules

**Objective:** Replace ad hoc follow-up detection in `reviewer-runner.ts` with reusable extraction/state logic.

**Files:**
- Modify: `src/automation/reviewer-runner.ts`
- Modify: `src/automation/reviewer-runner.test.ts`

**Step 1: Add failing reviewer-runner tests**

Add cases for:
- reviewer assignment reason stays `follow-up-requested` when shared state reports open actionable items
- no requeue when the same thread is already `addressed`
- no requeue when thread is `obsolete`

**Step 2: Run only reviewer tests**

Run:
```bash
npm run test:unit -- src/automation/reviewer-runner.test.ts
```

Expected: FAIL.

**Step 3: Refactor `collectReviewerAssignments(...)`**

Implementation notes:
- compute `followUpItems = collectReviewFollowUpItems(...)`
- compute `resolvedStates = resolveReviewThreadStates(...)`
- replace `hasReviewerFollowUpPending(...)` branch with a check over shared states
- keep public runner behavior stable where possible
- export any new helper only if it is used in tests or scripts

**Step 4: Re-run reviewer tests**

Run:
```bash
npm run test:unit -- src/automation/reviewer-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/reviewer-runner.ts src/automation/reviewer-runner.test.ts
git commit -m "refactor: share reviewer follow-up and resolution state logic"
```

---

## Task 5: Refactor merger runner to block only on shared `open` thread states

**Objective:** Make merge gating explicitly depend on shared resolution-state output rather than raw unresolved-thread checks.

**Files:**
- Modify: `src/automation/merger-runner.ts`
- Modify: `src/automation/merger-runner.test.ts`

**Step 1: Add failing merger tests**

Cover:
- `open` thread blocks merge
- `addressed` thread does not block merge
- `obsolete` thread does not block merge
- summary text names the resolution-state reason clearly

**Step 2: Run merger tests**

Run:
```bash
npm run test:unit -- src/automation/merger-runner.test.ts
```

Expected: FAIL.

**Step 3: Implement the refactor**

Changes:
- replace raw `thread.isResolved` merge gate with shared `resolveReviewThreadStates(...)`
- keep `review-follow-up-pending` only for truly open current-head work, or collapse that branch into the shared state if cleaner
- update `buildMergeGateSummary(...)` to mention `open`, `addressed`, and `obsolete` semantics

**Step 4: Re-run merger tests**

Run:
```bash
npm run test:unit -- src/automation/merger-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/merger-runner.ts src/automation/merger-runner.test.ts
git commit -m "feat: drive merge gating from shared review resolution state"
```

---

## Task 6: Add failing tests for planner artifact serialization and parsing

**Objective:** Define one machine-readable review-follow-up plan artifact before wiring planner and implementor.

**Files:**
- Create: `src/automation/planner-artifact.test.ts`
- Create: `src/automation/planner-artifact.ts`

**Step 1: Write failing tests**

Cover:
- serialize + parse round-trip for valid review-follow-up artifact
- parser rejects missing `threadId`
- parser rejects empty step arrays
- generic issue plan stays out of review-follow-up parser path

Example skeleton:

```ts
it('round-trips a valid review follow-up plan artifact', () => {
  const artifact: ReviewFixPlanArtifact = {
    kind: 'review-follow-up',
    threadId: 'thread-1',
    headSha: 'abc123',
    fixSummary: 'Cover fallback path',
    implementationSteps: ['Update fallback handling.'],
    testSteps: ['Add regression test for fallback error path.'],
    verificationSteps: ['Run targeted automation tests.'],
  };

  expect(parsePlannerArtifact(serializePlannerArtifact(artifact))).toEqual(artifact);
});
```

**Step 2: Run focused tests**

Run:
```bash
npm run test:unit -- src/automation/planner-artifact.test.ts
```

Expected: FAIL.

**Step 3: Implement serializer/parser**

Prefer one fenced metadata section or one HTML comment payload, for example:

```md
<!-- AGENT-PLANNER-ARTIFACT
{...json...}
-->
```

Do not require markdown scraping of bullet text.

**Step 4: Re-run focused tests**

Run:
```bash
npm run test:unit -- src/automation/planner-artifact.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/planner-artifact.ts src/automation/planner-artifact.test.ts
git commit -m "test: add planner artifact parsing coverage"
```

---

## Task 7: Extend planner runner to emit review-follow-up artifact comments

**Objective:** Make planner output machine-readable for review-driven work while preserving the current generic issue path.

**Files:**
- Modify: `src/automation/planner-runner.ts`
- Modify: `src/automation/planner-runner.test.ts`
- Modify: `scripts/run-planner.ts`

**Step 1: Add failing planner-runner tests**

Add cases for:
- review-follow-up issue body/context -> planner comment contains serialized artifact
- generic issue path still emits the current bounded implementation plan
- equivalent artifact comments deduplicate cleanly

**Step 2: Run planner tests**

Run:
```bash
npm run test:unit -- src/automation/planner-runner.test.ts
```

Expected: FAIL.

**Step 3: Implement artifact-aware planning**

Suggested approach:
- add a narrow detector such as `extractReviewFollowUpContext(issue.body)`
- if review-follow-up context exists, build `ReviewFixPlanArtifact`
- append serialized artifact to human-readable planner comment
- keep `evaluatePlannerDecision(...)` backward compatible for non-review issues

**Step 4: Re-run planner tests**

Run:
```bash
npm run test:unit -- src/automation/planner-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/planner-runner.ts src/automation/planner-runner.test.ts scripts/run-planner.ts
git commit -m "feat: emit planner artifacts for review follow-up work"
```

---

## Task 8: Extend implementor runner to consume planner artifacts and thread follow-up items

**Objective:** Ensure implementor input is typed and does not depend on heuristic issue-body parsing.

**Files:**
- Modify: `src/automation/implementor-runner.ts`
- Modify: `src/automation/implementor-runner.test.ts`
- Modify: `scripts/run-implementor.ts`

**Step 1: Add failing implementor tests**

Cover:
- parsed implementor task payload includes planner artifact and review follow-up items
- invalid artifact in payload fails closed
- successful result builds thread reply plan(s)

**Step 2: Run implementor tests**

Run:
```bash
npm run test:unit -- src/automation/implementor-runner.test.ts
```

Expected: FAIL.

**Step 3: Implement typed payload support**

Add to task payload:

```ts
{
  issue,
  reviewFollowUpItems,
  plannerArtifact,
}
```

Implementation notes:
- use the parser from `planner-artifact.ts`
- require valid `threadId`, `headSha`, and non-empty steps for review-follow-up mode
- keep normal issue implementation mode working without the artifact

**Step 4: Re-run implementor tests**

Run:
```bash
npm run test:unit -- src/automation/implementor-runner.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/automation/implementor-runner.ts src/automation/implementor-runner.test.ts scripts/run-implementor.ts
git commit -m "feat: consume planner artifacts in implementor workflow"
```

---

## Task 9: Add GitHub runtime support for review-thread replies

**Objective:** Give the implementor script a first-class helper for replying into review threads.

**Files:**
- Modify: `scripts/github-agent-runtime.ts`
- Modify: `scripts/github-agent-runtime.test.ts`
- Modify: `scripts/run-implementor.ts`

**Step 1: Add failing runtime tests**

Test the smallest possible helper surface, for example:
- `createReviewThreadReply(config, pullRequestNumber, threadId, body)` sends the expected GraphQL mutation payload
- invalid GraphQL response throws a typed script error message

**Step 2: Run the script tests**

Run:
```bash
npm run test:unit -- scripts/github-agent-runtime.test.ts
```

Expected: FAIL.

**Step 3: Implement runtime helper**

Suggested shape:

```ts
export async function createReviewThreadReply(
  config: IssueRuntimeConfig,
  input: { readonly pullRequestNumber: number; readonly threadId: string; readonly body: string },
): Promise<void>
```

Prefer one helper in `github-agent-runtime.ts` over inline `fetch` in `run-implementor.ts`.

**Step 4: Wire implementor script to publish replies after a successful result**

Rules:
- only if `result.pullRequest` exists
- only for actionable items with `requiresReply: true`
- safe if zero reply plans are present
- thread reply text must say it was prepared by an agent

**Step 5: Re-run script tests**

Run:
```bash
npm run test:unit -- scripts/github-agent-runtime.test.ts src/automation/implementor-runner.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/github-agent-runtime.ts scripts/github-agent-runtime.test.ts scripts/run-implementor.ts
git commit -m "feat: publish implementor replies to review threads"
```

---

## Task 10: Update `docs/AUTONOMOUS-AGENTS.md` to document the new state model and handoff

**Objective:** Keep repo policy and runtime behavior aligned.

**Files:**
- Modify: `docs/AUTONOMOUS-AGENTS.md`

**Step 1: Edit the document**

Add a new subsection near review/merge currentness covering:
- actionable review follow-up items
- thread states `open`, `addressed`, `obsolete`
- merge blocking rule: only `open` blocks
- planner artifact for review-driven fix/test handoff
- implementor in-thread reply requirement after successful fix attempts

**Step 2: Manual verification**

Check that doc text matches the implemented contracts exactly.

**Step 3: Commit**

```bash
git add docs/AUTONOMOUS-AGENTS.md
git commit -m "docs: define review follow-up state and planner artifact flow"
```

---

## Task 11: Run focused regression suite, then full required validation

**Objective:** Verify the combined PR before opening review.

**Files:**
- No new files

**Step 1: Run focused tests**

```bash
npm run test:unit -- \
  src/automation/review-follow-up.test.ts \
  src/automation/review-resolution-state.test.ts \
  src/automation/planner-artifact.test.ts \
  src/automation/reviewer-runner.test.ts \
  src/automation/merger-runner.test.ts \
  src/automation/planner-runner.test.ts \
  src/automation/implementor-runner.test.ts \
  scripts/github-agent-runtime.test.ts
```

Expected: PASS.

**Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS.

**Step 3: Run the broader required test command if the focused suite changed shared behavior more than expected**

```bash
npm test
```

Expected: PASS.

**Step 4: Review diff for accidental scope growth**

Checklist:
- no duplicate metadata parsing helpers were added
- no runner contains transport-specific GitHub code that belongs in runtime helpers
- planner artifact parser is strict and bounded
- merger policy is shared-state driven, not a second copy of reviewer heuristics

**Step 5: Final commit if needed**

```bash
git add -A
git commit -m "feat: close the review follow-up loop for autonomous PR handling"
```

---

## Acceptance checklist for the PR description

- [ ] Reviewer can extract actionable current-head follow-up items.
- [ ] Implementor receives machine-readable follow-up items and planner artifact.
- [ ] Successful implementor runs can reply into concrete review threads.
- [ ] Shared resolution-state module classifies `open`, `addressed`, and `obsolete`.
- [ ] Merger blocks only on `open` current-head review work.
- [ ] Planner emits structured review-follow-up fix/test artifacts without breaking generic planning.
- [ ] Focused tests and `npm run typecheck` pass.
- [ ] Documentation matches actual state-machine behavior.

## Suggested PR title

`feat: close the review follow-up loop for autonomous PR handling`

## Suggested PR body starter

```md
## Summary
- add shared review follow-up extraction, resolution-state classification, and planner artifact helpers
- wire reviewer, planner, implementor, and merger stages to consume the shared contracts
- publish agent-authored follow-up replies into review threads and document the merge policy

## Testing
- npm run test:unit -- src/automation/review-follow-up.test.ts src/automation/review-resolution-state.test.ts src/automation/planner-artifact.test.ts src/automation/reviewer-runner.test.ts src/automation/merger-runner.test.ts src/automation/planner-runner.test.ts src/automation/implementor-runner.test.ts scripts/github-agent-runtime.test.ts
- npm run typecheck
```
