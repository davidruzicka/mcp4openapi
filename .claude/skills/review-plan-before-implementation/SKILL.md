---
name: review-plan-before-implementation
description: Run an interactive pre-implementation plan review with explicit tradeoffs, opinionated recommendations, and user checkpoints before any code changes. Use when asked to review a plan, challenge architecture, assess quality/testing/performance risks, or decide implementation direction.
---

# Pre-Implementation Plan Review

Review plans thoroughly before making code changes. For every issue or recommendation, explain concrete tradeoffs, give an opinionated recommendation, and ask for user input before choosing a direction.

Do not start implementation until the user explicitly approves implementation.

## Engineering Preferences

- Flag DRY violations aggressively.
- Treat strong test coverage as mandatory.
- Target "engineered enough": avoid both fragile hacks and premature abstraction.
- Prefer handling more edge cases over fewer.
- Prefer explicit solutions over clever shortcuts.

## Start Protocol

Ask the user to choose one mode first:

1. **BIG CHANGE**  
   Review interactively section by section  
   (Architecture -> Code Quality -> Test -> Performance)  
   with at most 4 top issues per section.
2. **SMALL CHANGE**  
   Review interactively one key question per section.

Wait for mode selection before reviewing sections.

## Review Sections

Review in this order:

1. Architecture Review
2. Code Quality Review
3. Test Review
4. Performance Review

Pause after each section and ask for user feedback before moving to the next section.

### 1) Architecture Review

Evaluate:

- Overall system design and component boundaries.
- Dependency graph and coupling concerns.
- Data flow patterns and potential bottlenecks.
- Scaling characteristics and single points of failure.
- Security architecture (auth, data access, API boundaries).

### 2) Code Quality Review

Evaluate:

- Code organization and module structure.
- DRY violations.
- Error handling patterns and missing edge cases.
- Technical debt hotspots.
- Over-engineered and under-engineered areas.

### 3) Test Review

Evaluate:

- Coverage gaps (unit, integration, e2e).
- Test quality and assertion strength.
- Missing edge case coverage.
- Untested failure modes and error paths.

### 4) Performance Review

Evaluate:

- N+1 queries and database access patterns.
- Memory-usage concerns.
- Caching opportunities.
- Slow or high-complexity code paths.

## Required Issue Format

For each issue, include:

1. **Issue NUMBER** and short title.
2. Concrete description with file and line references.
3. **2-3 options**, including "do nothing" when reasonable.
4. For each option: implementation effort, risk, impact on other code, maintenance burden.
5. Opinionated recommendation mapped to engineering preferences.
6. Explicit user decision question with issue NUMBER and option LETTER.

Always put the recommended option first.

Use letters for options:

- **A.** Recommended option
- **B.** Alternative option
- **C.** Do nothing (if reasonable)

Use this output template:

```markdown
Issue <NUMBER>: <Title>
Files: <path:line>, <path:line>

Problem
- <concrete risk or defect>

Options
- A. <recommended option>
  - Effort: <low/medium/high>
  - Risk: <low/medium/high>
  - Impact: <scope of change>
  - Maintenance: <expected burden>
- B. <alternative option>
  - Effort: <low/medium/high>
  - Risk: <low/medium/high>
  - Impact: <scope of change>
  - Maintenance: <expected burden>
- C. <do nothing or fallback option>
  - Effort: <low/medium/high>
  - Risk: <low/medium/high>
  - Impact: <scope of change>
  - Maintenance: <expected burden>

Recommendation
- Recommend A because <reason tied to user preferences>.

Question
- Issue <NUMBER>: choose A, B, or C?
```

## Interaction Rules

- Do not assume timeline, scope, or priorities.
- Ask for user input before selecting direction.
- If no major issue exists in a section, say so explicitly and provide one optional improvement question.
- Keep recommendations opinionated but practical.

