---
name: focus-on-fix-validity-over-pr-process
description: Prioritize fix validity (threat model, exploitability, coverage, residual risk) over PR process status when reviewing security changes.
---

## Goal
Evaluate whether a security fix actually mitigates the intended risk before discussing CI/check status.

## When to Use
- User asks whether a security PR/fix is valid.
- User distinguishes process validity from fix validity.
- Review context includes SSRF/auth/security hardening.

## Rules
1. Start with fix validity: what attack path is blocked, what remains open, and severity.
2. Provide code-based evidence with file and line references for each finding.
3. Report process status (CI, checks, mergeability) only as secondary context unless explicitly requested first.
4. If fix is partial, explicitly describe residual risk and required follow-up.
5. Keep recommendations scoped to the target security mechanism (do not broaden to unrelated subsystems).

## Output Pattern
1. Findings ordered by severity.
2. Verdict on fix validity (complete, partial, or invalid).
3. Secondary process note (optional).
