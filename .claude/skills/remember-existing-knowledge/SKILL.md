---
name: remember-existing-knowledge
description: Propose creating a new skill after a correction reveals reusable existing knowledge, tools, policies, or preferred communication style. Trigger immediately for critical issues and on repetition for trivial patterns.
---

## Goal
Capture lessons from corrections by proposing a new skill that preserves existing knowledge, avoids repeated mistakes, and aligns with preferred behavior.

Also ensure existing skills are respected by extending them when they should have applied but lacked a trigger or instruction.

## When to Use
- The user corrects a prior proposal, implementation, communication style or different chat pattern.
- The correction reveals a reusable rule, tool, policy, or preferred pattern.

## Preconditions
- A correction or review has occurred in the current conversation.
- The correction is relevant beyond the single instance.
- A quick scan of existing skills shows no match, or a near match that can be fixed by updating the existing skill.

## Definitions
- **Critical issue**: A correction that affects UI/UX, API, DB scheme, architecture, safety, compliance, legal risk, financial impact, or major business outcomes. Propose a new skill immediately on first occurrence.
- **Trivial pattern**: A small or low‑impact correction (formatting, minor naming, minor style preferences). Propose a new skill only after repetition.

## Illustrative Categories (Non‑exhaustive)
**Critical examples**
- Programming: API changes, database schema changes, UI modifications, programming patterns.
- Engineering: Security or compliance rule (e.g., use approved validation utilities, avoid direct credential handling).
- Product: Regulatory constraints or roadmap policy that changes what can be shipped.
- Business: Pricing or contractual commitments that must be enforced.
- HR: Hiring or privacy rules that must be followed.
- Accounting: Tax or audit requirements that change reporting behavior.
- Legal: Contract clauses or jurisdiction requirements that alter guidance.

**Trivial examples**
- Engineering: Preferred code style or naming convention.
- Product: Template wording or formatting of a status update.
- Business: Slide layout preference.
- HR: Preferred phrasing in internal comms.
- Accounting: Report section ordering.
- Legal: Minor citation format preference.

## Rules
1. If the correction is **critical**, propose a new skill immediately.
2. If the correction is **trivial**, propose a new skill only after the pattern repeats.
3. If the correction changes the assistant’s **communication style**, propose a new skill immediately if it is a strong preference or policy, otherwise wait for repetition.
4. Always propose a **positive, goal‑oriented** skill name (e.g., “remember‑existing‑knowledge”).
5. The skill proposal must include a one‑sentence **Why now** justification.
6. Before proposing a new skill, check existing skills by name and description to avoid duplicates.
7. If an existing skill should have triggered but did not, update that skill instead of proposing a new one.

## Procedure
1. Identify the correction and classify it as critical or trivial.
2. Scan existing skills for a matching or near matching description.
3. If a matching skill exists, update its SKILL.md to include the missing trigger, condition, or instruction.
4. If no matching skill exists, decide whether to propose a new skill based on the Rules.
5. Draft a proposed skill (name + description + key rules).
6. Ask the user to confirm creation of the new skill.

## Output Format
Use the language of the last messages; if mixed, use the most recent message.

```text
Proposal: Create a new skill
Name: <proposed-skill-name>
Description: <1–2 sentence description>
Key rules:
- <rule 1>
- <rule 2>
Why now: <one sentence>

Create this skill now? (yes/no)
```

## Examples
- After a code review reveals an existing validation utility must be used, propose a skill that prioritizes approved shared utilities.
- After a PM corrects a roadmap constraint that changes scope decisions, propose a skill capturing that constraint.
- After a style correction that repeats across messages, propose a skill capturing the preferred tone or format.

## Avoid
- Creating a skill for a one‑off correction with no reuse value.
- Proposing a skill that merely restates the user’s prompt without a reusable rule.
- Ignoring the critical vs. trivial distinction.
- Using a negative or prohibitive skill name.
- Skipping the user confirmation step.
- Duplicating an existing skill when a small update would solve the issue.
