# Autonomous Agents

This document defines the first repository-specific version of the multi-agent issue-to-PR workflow and the feedback/evaluation loop around it.

## Goals

- Keep autonomous work narrow, testable, and auditable.
- Make agent state machine decisions deterministic.
- Preserve human override at every critical boundary.
- Capture structured feedback that can improve prompts and policies without allowing uncontrolled self-modification.

## Agent Roles

### `issuer`

- Examines issues.
- Decides whether work is safe for autonomous execution.
- Applies or removes the autonomy gate labels.

### `planner`

- Produces a concrete implementation plan on the issue.
- Re-checks whether the issue still belongs in the autonomous lane after deeper analysis.
- Hands off only when the plan is specific enough to implement safely.

### `implementor`

- Takes planned issues.
- Implements the change in a branch.
- Opens a PR with tests and an explicit agent note.

### `reviewer`

- Reviews the current PR head SHA.
- Leaves machine-readable review metadata.
- Re-reviews after new commits when earlier review metadata becomes stale.

### `merger`

- Merges only after current-sha review requirements, CI, and hold gates are satisfied.

### `evaluator`

- Never directs implementation.
- Aggregates human feedback and agent metadata.
- Requests clarification when feedback is only a thumbs-up or thumbs-down and more context would materially help.
- Produces prompt/policy recommendations for human approval.

## Label Taxonomy

### Issue labels

- `agent:safe` - Small, concrete, low-risk issue approved for autonomous work.
- `agent:needs-plan` - Work needs explicit design/planning before implementation.
- `agent:investigate` - Next step should be reproduction, scoping, or analysis.
- `agent:planned` - Planner left a current plan that still keeps the issue in the autonomous lane.
- `agent:implementing` - An implementor lease is active.
- `agent:blocked` - Automation should stop until a human intervenes.
- `human:hold` - Human explicitly paused automation for this issue or its linked PR.

### PR labels

- `agent:created` - PR was created by automation.
- `agent:review:required` - PR needs at least one agent review pass.
- `agent:review:in-progress` - A reviewer lease is active.
- `agent:review:done` - Review for the current expected lane completed; metadata must still match the current head SHA.
- `agent:ready-to-merge` - All deterministic merge gates appear satisfied.
- `agent:blocked` - PR is blocked for automation.
- `human:hold` - Human explicitly paused merge automation.

Notes:
- Labels are coarse workflow hints.
- Source of truth for currentness is metadata + current head SHA, not labels alone.

## Comment Metadata

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

## Review Currentness Rule

A review is current only when:

- its latest review metadata has `status: approved`, and
- its `head-sha` matches the current PR head SHA.

If the head SHA changes, the prior approval is stale and should not count toward merge.

## Evaluator Feedback Loop

### Human feedback

Humans can react with thumbs-up/thumbs-down or leave a short comment.

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

## Merge Gates

The merger should merge only when all of the following are true:

1. PR is not draft.
2. No `human:hold` label is present.
3. No `agent:blocked` label is present.
4. No review lease is currently active.
5. Required reviewer approvals exist for the current head SHA.
6. No unresolved review conversations remain.
7. CI is green.
8. No later negative review metadata supersedes an earlier approval.

## First-Version Implementation Assets

This repository includes small automation helpers for evaluator feedback and reviewer lease selection:

- `src/automation/agent-feedback.ts`
- `src/automation/evaluator-runner.ts`
- `src/automation/reviewer-runner.ts`
- `src/automation/merger-runner.ts`
- `scripts/render-agent-feedback-template.ts`
- `scripts/run-evaluator.ts`
- `scripts/run-reviewer.ts`
- `scripts/run-merger.ts`
- `.github/workflows/evaluator.yml`
- `.github/workflows/reviewer.yml`
- `.github/workflows/merger.yml`

The current implementation intentionally focuses on bounded deterministic slices first:

- deciding when thumbs-only feedback should trigger an evaluator follow-up request,
- generating stage-specific feedback-request comment templates,
- scanning recent issue/PR bodies plus issue comments for agent metadata and thumbs-only reactions,
- selecting PRs that need a reviewer pass for the current head SHA,
- acquiring reviewer leases with explicit metadata so duplicate review runs are less likely.

Current first-version runtime scope:

- evaluator supports issue bodies, PR bodies, and issue comments,
- evaluator skips targets with mixed thumbs-up/thumbs-down signals,
- evaluator deduplicates follow-up comments by evaluator metadata (`target-type` + `target-number`),
- reviewer selects only non-draft PRs with `agent:review:required` and no blocking labels,
- reviewer treats current-head terminal review metadata (`approved`, `changes-requested`, `commented`) as already handled,
- reviewer uses lease TTL plus `status: reviewing` metadata to avoid duplicate pickup,
- reviewer now publishes bounded semantic review decisions to GitHub reviews using transparent policy checks (current scope: missing agent disclosure, code-without-tests, docs-only approvals),
- merger now evaluates deterministic merge gates for recent PRs, reconciles the `agent:ready-to-merge` label, and emits deduplicated merger metadata comments based on current-head approval, review lease, unresolved thread, and CI state,
- reviewer still does not yet perform broader AI-driven code reasoning,
- merger does not yet execute the final merge action or wait on human reply semantics beyond unresolved review threads / hold labels,
- neither helper yet persists long-term feedback history.

## Future Work

Recommended next steps after this first version:

1. Extend the evaluator scanner to cover pull-request reviews and inline review comments.
2. Persist structured feedback records for weekly evaluator reports.
3. Add issue/PR label reconciliation helpers for issuer/planner/implementor stages.
4. Teach the merger to inspect human reply semantics more deeply (for example agent-owned review follow-up threads).
5. Add the final merge executor only after deterministic gate evaluation has proven stable.
