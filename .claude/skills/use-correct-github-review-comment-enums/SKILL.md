---
name: use-correct-github-review-comment-enums
description: Enforce schema-correct enum values when posting GitHub PR review comments via MCP tools. Use when creating inline review comments or handling tool validation errors for review-thread parameters.
---

## Goal
Prevent avoidable GitHub MCP tool failures caused by invalid enum values or casing in review-comment payloads.

## When to Use
- You call `mcp__github__add_comment_to_pending_review`.
- You create or submit PR review comments with enum fields such as `subjectType` or `side`.
- A prior tool call failed with GraphQL validation mentioning enum mismatch.

## Rules
1. Validate enum fields before sending:
- `subjectType` must be `LINE` or `FILE`.
- `side` and `startSide` should use `LEFT` or `RIGHT` when present.
2. Prefer `subjectType: LINE` for inline code comments.
3. Include `path` and `line` for inline comments; use `subjectType: FILE` only for file-level comments.
4. If a validation error reports enum mismatch, retry once with corrected enum casing/values without changing comment meaning.
5. Do not repeat retries beyond one automatic correction attempt.
6. Keep review text unchanged while fixing transport/schema fields.

## Procedure
1. Build comment payload and preflight-check enum fields.
2. Send tool call.
3. If response contains enum-validation error:
- map invalid enum values to valid constants (`LINE`/`FILE`, `LEFT`/`RIGHT`),
- resend exactly once.
4. Confirm comment presence by reading review comments after successful submission.

## Quick Reference
- Correct: `subjectType: "LINE"`
- Incorrect: `subjectType: "line"`

