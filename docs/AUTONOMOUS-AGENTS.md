# Autonomous Agents

This document defines the repository-specific autonomous issue-to-PR workflow, its label taxonomy, migration rules, and deterministic merge gates.

## Goals

- Keep autonomous work narrow, testable, and auditable.
- Make workflow state-machine decisions deterministic.
- Preserve human override at every critical boundary.
- Support gradual migration from the current label model without unsafe bulk relabeling.
- Capture structured feedback that can improve prompts and policies without allowing uncontrolled self-modification.

## Core principles

- Labels represent coarse workflow state, not free-form commentary.
- Machine-readable metadata is the source of truth for leases, head SHA binding, timestamps, and review currentness.
- All agents must be idempotent.
- All active ownership must use lease TTL, not permanent locks.
- `human:hold` always wins over automation.
- Migration uses dual-read, new-write, and on-touch reconciliation.

## Agent Roles

### `proposal-intake`

- Examines new automation proposals before a fresh issue is created.
- Checks bounded open/closed issue and PR candidates for duplicates, regressions, and follow-up work.
- Chooses one deterministic outcome: `comment-existing`, `create-and-link`, `create-fresh`, `reject-as-duplicate`, or `no-action`.
- Must prefer no-op over noisy or ambiguous duplicate handling.

### `issuer`

- Examines issues.
- Decides whether work is safe for autonomous execution.
- Applies the autonomy gate labels that route work into the planning lane.

### `planner`

- Produces a concrete implementation plan on the issue.
- Re-checks whether the issue still belongs in the autonomous lane after deeper analysis.
- Hands off only when the plan is specific enough to implement safely.

### `implementor`

- Takes planned issues.
- Implements the change in a branch.
- Opens a PR with tests and an explicit agent note.
- The default GitHub Actions backend uses a Codex CLI wrapper that consumes `IMPLEMENTOR_TASK_JSON`, runs Codex inside the checked-out repository/worktree, and requires a machine-readable JSON result before the orchestration layer updates labels.

### `reviewer`

- Reviews the current PR head SHA.
- Leaves machine-readable review metadata.
- Re-reviews after new commits or newer external thread replies when earlier review metadata becomes stale.

### `merger`

- Evaluates whether the current PR head is merge-ready.
- Reconciles `agent:ready-to-merge` only when deterministic gates are satisfied.

### `merge-executor`

- Performs the actual merge after final live revalidation.
- Uses the current head SHA as a fail-safe lease.

### `evaluator`

- Never directs implementation.
- Aggregates human feedback and agent metadata.
- Requests clarification when feedback is only a thumbs-up or thumbs-down and more context would materially help.
- Produces prompt/policy recommendations for human approval.

## Final label taxonomy

### Issue labels

- `agent:safe` - Issue is currently considered eligible for autonomous handling.
- `agent:needs-plan` - Issue is eligible and awaiting planner output.
- `agent:planned` - Planner produced a current acceptable plan and the issue remains eligible.
- `agent:implementing` - An implementor lease is active.
- `agent:blocked` - Automation should stop until a human intervenes or an external dependency changes.
- `human:hold` - Human explicitly paused automation.

### PR labels

- `agent:created` - PR was created by automation.
- `agent:review:required` - PR needs reviewer processing.
- `agent:review:in-progress` - A reviewer lease is active.
- `agent:review:done` - Review for the current lane completed; metadata must still match the current head SHA.
- `agent:ready-to-merge` - All deterministic merge gates appear satisfied.
- `agent:blocked` - PR is blocked for automation.
- `human:hold` - Human explicitly paused merge automation.

### Legacy labels still recognized during migration

- `agent:reviewing`
- `agent:reviewed`

Notes:
- Labels are coarse workflow hints.
- Source of truth for currentness is metadata plus current head SHA, not labels alone.
- New automation writes the final taxonomy and opportunistically removes legacy review labels after reconciliation.

## State machine

### Proposal intake resolution

Before an item enters the issue state machine, `proposal-intake` must classify it against a bounded shortlist of existing issues and PRs.

Deterministic outcomes:

- `comment-existing`
  - use when an open pre-implementation issue already tracks the same bounded work
- `create-and-link`
  - use when the closest match is already active (`agent:planned`, `agent:implementing`, or an open PR) or when a closed match is a true regression / follow-up
- `create-fresh`
  - use when no relevant bounded match exists
- `reject-as-duplicate`
  - use when the best match is an already closed exact duplicate with no new regression / follow-up scope
- `no-action`
  - use when candidate matches are ambiguous, the worktree is dirty, or runtime evidence is too weak for a safe decision

Required proposal-intake guardrails:

- bounded retrieval before detailed duplicate classification
- strict idempotency for comments / links / created issues
- explicit early exits on ambiguity or dirty automation state
- bounded proposal loading plus duplicate-candidate ranking independent from the side-effect budget
- proposal-intake-created issues remain valid tracking artifacts for duplicate matching but are never valid future proposal-intake source proposals
- at most one side effect per run, even when multiple bounded candidates look safe

### Issue states

- `candidate` -> no workflow labels
- `needs-plan` -> `agent:safe` + `agent:needs-plan`
- `planned` -> `agent:safe` + `agent:planned`
- `implementing` -> `agent:safe` + `agent:planned` + `agent:implementing`
- `blocked` -> `agent:blocked`
- `held` -> `human:hold`

### Issue transitions

#### Candidate -> needs-plan
Performed by `issuer` when coarse suitability passes.

Actions:
- add `agent:safe`
- add `agent:needs-plan`
- add issuer note with concise reasoning

#### Needs-plan -> planned
Performed by `planner` when detailed design still supports autonomous handling.

Actions:
- add `agent:planned`
- remove `agent:needs-plan`
- keep `agent:safe`
- update or replace the current planner comment

#### Needs-plan -> de-scoped / blocked
Performed by `planner` when deeper analysis reveals ambiguity, broad scope, missing acceptance criteria, or policy mismatch.

Actions:
- remove `agent:safe`
- remove `agent:needs-plan`
- optionally add `agent:blocked`
- explain why autonomous execution was rejected

#### Planned -> implementing
Performed by `implementor` when no open linked PR already exists.

Actions:
- acquire lease
- add `agent:implementing`
- publish implementor ownership metadata

#### Implementing -> planned
Performed by `implementor` on safe failure before PR creation.

Actions:
- remove `agent:implementing`
- keep `agent:planned`
- leave concise failure comment
- add `agent:blocked` only when retry should stop pending human help

#### Implementing -> PR created
Performed by `implementor` after successful PR creation.

Actions:
- remove `agent:implementing`
- keep `agent:safe`
- usually keep `agent:planned` for auditability
- link the PR from the issue

### PR states

- `candidate` -> no workflow labels
- `review-required` -> `agent:review:required`
- `review-in-progress` -> `agent:review:required` + `agent:review:in-progress`
- `review-done` -> `agent:review:required` + `agent:review:done`
- `ready-to-merge` -> `agent:review:required` + `agent:review:done` + `agent:ready-to-merge`
- `blocked` -> `agent:blocked`
- `held` -> `human:hold`

### PR transitions

#### PR created -> review required
Performed by `implementor`.

Actions:
- add `agent:created`
- add `agent:review:required`
- add visible disclosure to the PR body

#### Review required -> review in progress
Performed by `reviewer`.

Actions:
- acquire reviewer lease
- add `agent:review:in-progress`
- post reviewer lease metadata

#### Review in progress -> review done
Performed by `reviewer` for the current head SHA.

Actions:
- submit review comment / approval metadata
- add `agent:review:done`
- remove `agent:review:in-progress`
- remove legacy `agent:reviewing` / `agent:reviewed` labels if present

#### Review done -> review required
Triggered when review currentness is invalidated.

Invalidation conditions:
- PR head SHA changed
- reviewer-owned threads received newer external replies
- latest current-head decision is no longer approval-compatible

Actions:
- remove `agent:review:done`
- preserve or re-add `agent:review:required`
- remove `agent:ready-to-merge` if present

#### Review done -> ready to merge
Performed by `merger` when all deterministic gates pass.

Actions:
- add `agent:ready-to-merge`
- post merge evaluation metadata

#### Ready to merge -> not ready
Performed by `merger` reconciliation.

Actions:
- remove `agent:ready-to-merge`
- optionally add/update a reason summary comment

#### Ready to merge -> merged
Performed by `merge-executor` only after final live revalidation.

## Migration rules

Migration uses dual-read, new-write, and on-touch reconciliation.

### Safe migration behavior

- Keep `agent:safe` unchanged.
- Treat legacy review labels only as hints.
- Never trust `agent:reviewed` or `agent:ready-to-merge` without revalidating current metadata, threads, and head SHA.

### Legacy -> final mapping

#### Issue labels

- Existing `agent:safe` remains valid.
- If an issue has `agent:safe` and no planning state, planner may add `agent:needs-plan` on first touch.

#### PR labels

- `agent:reviewing`
  - convert to `agent:review:in-progress` only if a live reviewer lease exists for the current head SHA
  - otherwise treat as stale and remove opportunistically

- `agent:reviewed`
  - convert to `agent:review:done` only after revalidation against current head SHA, unresolved threads, and reviewer metadata
  - otherwise treat as stale and remove opportunistically

- `agent:ready-to-merge`
  - keep only if merge gates still pass for the current head SHA
  - otherwise remove during merger or merge-executor reconciliation

## Comment metadata

All agents should add a visible note plus a hidden metadata block.

```md
<!-- AGENT-METADATA
agent-id: reviewer
agent-stage: reviewer
agent-role: review
run-id: 2026-03-14T13:45:12Z-reviewer-001
repository: davidruzicka/mcp4openapi
issue-number: 155
pr-number: 156
head-sha: 8f3c1ab
status: approved
timestamp: 2026-03-14T13:45:12Z
-->
```

### Required fields

- `agent-id`
- `agent-stage`
- `agent-role`
- `run-id`
- `status`
- `timestamp`

### PR-related fields

- `pr-number`
- `head-sha`

### Optional but recommended fields

- `repository`
- `issue-number`
- `base-sha`
- `review-cycle`
- `reason`
- `ignore-for-workflow`

### Proposal-intake fields

- `proposal-key`
- `resolution`
- `target-issue-number`
- `target-pr-number`

## Required visible disclosure

All agent-authored issue comments, PR descriptions, review comments, and merge notes must explicitly disclose automation.

Recommended prefixes:

- `🤖 Agent note (issuer)`
- `🤖 Agent plan (planner)`
- `🤖 Agent implementation note (implementor)`
- `🤖 Agent review (reviewer)`
- `🤖 Agent note (merger)`
- `🤖 Agent note (merge-executor)`

## Review currentness rule

A review is current only when:

- its latest reviewer metadata has `status: approved`, and
- its `head-sha` matches the current PR head SHA.

If the head SHA changes, the prior approval is stale and must not count toward merge.

## Review follow-up state and handoff

Reviewer follow-up is now tracked with three shared per-thread states for the current automation lane:

- `open` - current-head thread is still unresolved on GitHub.
- `addressed` - current-head thread is resolved on GitHub or contains a current-head implementor follow-up reply.
- `obsolete` - thread metadata points at an older PR head, so the current merge decision ignores it.

Rules:

- Reviewer/planner handoff may include a machine-readable review-follow-up artifact for fix/test work.
- Planner-generated review-follow-up artifacts may be emitted as signed envelopes inside the existing `AGENT-PLANNER-ARTIFACT` fence.
- Lenient read-only paths (for example planner dedupe/debugging) may read signed or legacy unsigned artifacts, but execution paths must trust only verified artifacts.
- Unsigned artifacts are treated as untrusted text on execution paths unless `MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED=true` is enabled during migration.
- Signed verification uses `MCP4_AGENT_ARTIFACT_SIGNING_KEY` plus optional `MCP4_AGENT_ARTIFACT_KEY_ID` (`default` when omitted); first-pass signing is fixed to HMAC-SHA256.
- `MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED=false` is only valid when `MCP4_AGENT_ARTIFACT_SIGNING_KEY` is configured; startup should fail fast instead of leaving planner/implementor in a dead-end strict mode.
- Planner/implementor workflows pass `MCP4_AGENT_ARTIFACT_*` through from GitHub secrets/vars so signing can be enabled without editing the shipped workflow files.
- If a signed artifact is present but invalid, tampered, or the signing key is unavailable, implementor-side execution fails closed instead of silently downgrading to unsigned parsing.
- Key rotation is done by changing the secret and optionally the key ID; historical comments remain readable only on lenient/non-execution paths unless compatibility mode is explicitly enabled.
- Implementor artifact selection only considers planner-stage comments and orders candidates by comment creation time rather than edit time.
- Implementor follow-up replies must visibly disclose automation and include metadata bound to the replying head SHA.
- Merge policy is fail-closed: only `addressed` and `obsolete` are non-blocking; `open` blocks merge readiness.

## Merge gates

The merger should mark a PR ready only when all of the following are true:

1. PR is not draft.
2. No `human:hold` label is present.
3. No `agent:blocked` label is present.
4. No reviewer lease is currently active.
5. Required reviewer approval exists for the current head SHA.
6. No unresolved review conversations remain.
7. CI is green.
8. No later negative review metadata supersedes an earlier approval.
9. No reviewer-owned follow-up thread contains newer external replies than the latest reviewer response or decision for the current head SHA.
10. Branch protection does not require a stronger human approval lane than the bounded single-agent reviewer can satisfy.
11. The chosen merge method is allowed by repository policy.

## Evaluator feedback loop

### Human feedback

Humans can react with thumbs-up / thumbs-down or leave a short comment.

### Weak signal handling

If the signal is only a thumbs-up or thumbs-down and the evaluator determines that clarification would help, it should leave a short follow-up comment with:

- a one-line reply template,
- 2-4 suggested categories tailored to the target agent and situation,
- `ignore-for-workflow: true` metadata so other agents ignore it.

Example evaluator metadata:

```md
<!-- AGENT-METADATA
agent-id: evaluator
agent-role: feedback-request
target-agent-id: reviewer-quality
target-type: review
target-number: 156
status: awaiting-human-feedback
ignore-for-workflow: true
run-id: 2026-03-14T16:00:00Z-evaluator-001
timestamp: 2026-03-14T16:00:00Z
-->
```

### Evaluator comment rules

- Evaluator comments must never be treated as implementation instructions.
- Other agents must ignore evaluator comments when `agent-id: evaluator` or `ignore-for-workflow: true` is present.
- Evaluator can suggest categories, but should not claim a root cause as fact unless a human already confirmed it.

## Current implementation assets

This repository currently includes small automation helpers for evaluator feedback, review / merge state reconciliation, and deterministic workflow transitions:

- `src/automation/agent-feedback.ts`
- `src/automation/agent-workflow-state.ts`
- `src/automation/evaluator-runner.ts`
- `src/automation/proposal-intake.ts`
- `src/automation/proposal-intake-runner.ts`
- `src/automation/issuer-runner.ts`
- `src/automation/planner-runner.ts`
- `src/automation/implementor-runner.ts`
- `src/automation/reviewer-runner.ts`
- `src/automation/merger-runner.ts`
- `src/automation/merge-executor.ts`
- `scripts/github-agent-runtime.ts`
- `scripts/render-agent-feedback-template.ts`
- `scripts/merger-runtime.ts`
- `scripts/run-evaluator.ts`
- `scripts/run-issuer.ts`
- `scripts/run-planner.ts`
- `scripts/run-implementor.ts`
- `scripts/run-reviewer.ts`
- `scripts/run-merger.ts`
- `scripts/run-merge-executor.ts`
- `.github/workflows/evaluator.yml`
- `.github/workflows/issuer.yml`
- `.github/workflows/planner.yml`
- `.github/workflows/implementor.yml`
- `.github/workflows/reviewer.yml`
- `.github/workflows/merger.yml`
- `.github/workflows/merge-executor.yml`

Current implemented runtime scope:

- evaluator supports issue bodies, PR bodies, and issue comments,
- evaluator skips targets with mixed thumbs-up / thumbs-down signals,
- evaluator deduplicates follow-up comments by evaluator metadata,
- issuer performs bounded heuristic triage for recently updated issues and writes migration-safe autonomy gate comments plus labels,
- proposal-intake now includes deterministic duplicate/follow-up/regression ranking, bounded GitHub issue/PR candidate retrieval, a candidate-bound workflow input that stays separate from the single-action side-effect budget, dirty-worktree early exit, and metadata-backed duplicate comments,
- planner turns `agent:safe` + `agent:needs-plan` issues into explicit bounded implementation plans or de-scopes / blocks them with machine-readable rationale,
- implementor acquires issue leases for `agent:planned` work, records implementation ownership, and can hand off execution to a configurable external command that returns structured PR metadata,
- implementor auto-labels created PRs for review and backfills a visible agent disclosure in the PR body when the backend omitted one,
- reviewer selects non-draft PRs with review-lifecycle labels and no blocking labels,
- reviewer treats current-head terminal review metadata as already handled,
- reviewer uses lease TTL plus `status: reviewing` metadata to avoid duplicate pickup,
- reviewer requeues PRs when reviewer-owned discussion threads receive newer external replies,
- reviewer publishes bounded semantic review decisions to GitHub reviews with transparent policy checks,
- reviewer and merger now tolerate legacy `agent:reviewing` / `agent:reviewed` labels during migration,
- merger evaluates deterministic merge gates, reconciles `agent:ready-to-merge`, and emits deduplicated merger metadata comments,
- merge executor revalidates the current head SHA plus deterministic merge gates before calling the GitHub merge API.

Current intentionally unimplemented runtime scope:

- in-workflow coding model execution for implementor (the runtime expects an external command/backend),
- specialized multi-lane reviewers,
- long-term feedback persistence.

## Future work

Recommended next steps:

1. Add a separately configured multi-action side-effect budget for proposal-intake only if idempotency, ordering, and ambiguity guardrails are proven safe; the current `max_candidates` bound intentionally does not change the one-action-per-run limit.
2. Replace the bounded heuristic issuer / planner decisions with a stronger pluggable semantic backend once prompt contracts and guardrails are finalized.
3. Extend evaluator scanning to pull-request reviews and inline review comments.
4. Persist structured feedback records for weekly evaluator reports.
5. Persist agent-owned review-thread references so specialized reviewers can re-enter the exact conversations they opened.
6. Extend branch-protection-aware merge policy beyond the current conservative single-reviewer model.
7. Add first-class issue creation/linking actions for `create-fresh` and `create-and-link` once the proposal source and idempotent link format are finalized.
