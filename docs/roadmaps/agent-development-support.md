# Agent development support roadmap

This document tracks the GitHub-native planning structure for agent-assisted development work in `mcp4openapi`.

## Canonical planning surfaces

- GitHub Project: <https://github.com/users/davidruzicka/projects/2>
- Tracking issue: #185
- Review/fix loop tracking issue: #184

Use the GitHub Project for live status, priority, and queue management.
Use this roadmap for dependency notes, execution order, and planning context that is too verbose for project fields.

## Current issue set

### Phase 1 - close the PR review/fix loop

1. #178 - Add PR review comment resolution loop
2. #179 - Track review comment resolution state per head SHA
3. #180 - Define merge blocking policy for unresolved review threads
4. #181 - Extend planner output for review-follow-up fix/test plans

### Phase 2 - operational hardening

5. #182 - Add observability for agent pipeline stages
6. #183 - Define human escalation rules for agent stages

## Dependencies

- #179 depends on #178.
- #180 depends on #179.
- #181 depends on #178 and should align with #179.
- #183 should align with #180.
- #182 can progress in parallel, but should validate the final workflow shape after phase 1 stabilizes.
- #184 tracks phase-1 delivery.
- #185 tracks the full roadmap and project structure.

## Recommended project fields

The GitHub Project is configured with these planning fields:

- `Status`: `Todo`, `In Progress`, `Done`
- `Priority`: `P0`, `P1`, `P2`, `P3`
- `Stream`: `Roadmap`, `Review loop`, `Planner`, `Merge policy`, `Observability`, `Escalation`
- `Depends on`: free-text dependency reference such as `#178`

## Operating model

### Tracking issues

- #184 is the focused execution tracker for review/fix loop delivery.
- #185 is the top-level roadmap tracker for the whole agent-support workstream.

### Child issues

Each implementation issue should stay narrow, testable, and independently reviewable.
If a child issue grows into a multi-step design task, split it into additional child issues instead of widening the original scope.

### Pull request guidance

- Keep roadmap/documentation changes separate from runtime behavior changes when practical.
- Prefer one PR per implementation issue.
- Keep PR descriptions agent-authored and explicitly say the text was prepared by an agent.

## Exit criteria

### Phase 1

- The pipeline can detect unresolved review comments for the active PR head.
- The pipeline can map actionable review feedback into follow-up work.
- The agent can reply in-thread after a fix attempt.
- Merge behavior is deterministic for blocking vs non-blocking vs obsolete review threads.

### Phase 2

- Operators can see whether the pipeline is progressing or stalling.
- Ambiguous or unsafe cases escalate with enough structured context for a human to take over.

## Notes

If GitHub later gains stronger issue dependency primitives for this repository setup, prefer native dependency fields over free-text dependency references while keeping this document as the human-readable roadmap.
