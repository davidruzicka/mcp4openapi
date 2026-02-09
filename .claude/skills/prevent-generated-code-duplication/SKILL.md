---
name: prevent-generated-code-duplication
description: Detect and refactor duplicate logic introduced by generated code, including overlaps between generated artifacts and existing project code.
---

## Goal
Prevent divergence and maintenance risk by consolidating duplicated logic created by code generation or by mixing generated and hand-written code.

## When to Use
- New generated files duplicate logic already present in the project.
- Generated output duplicates existing generated modules.
- Generated code and hand-written code implement equivalent validation/parsing/mapping/error handling.
- Reviews identify repeated blocks after schema/code generation.

## Rules
1. Treat generated-vs-existing duplication as high-priority technical debt and resolve in the same change when feasible.
2. Prefer extraction to shared runtime modules (helpers/utilities/services), not copy-paste edits across multiple generated files.
3. Keep codegen outputs thin: delegate behavior to shared functions where possible.
4. If generator templates are available, fix duplication at template/source level first.
5. If template-level fix is not feasible, add a small shared abstraction and route both generated and existing code through it.
6. Preserve behavior and public interfaces; avoid broad architecture changes unless required.
7. Validate with lint, typecheck, and relevant tests after deduplication.

## Workflow
1. Identify duplicate blocks and classify:
   - generated <-> generated
   - generated <-> hand-written
2. Pick dedup strategy:
   - template fix (preferred)
   - shared helper/module extraction
3. Refactor call sites to shared implementation.
4. Remove duplicated code paths.
5. Run verification (lint + typecheck + tests).
6. Document the dedup decision in change summary.

## Output Pattern
1. Duplicates found (files + intent).
2. Chosen dedup strategy and why.
3. Refactored shared location.
4. Verification results.
