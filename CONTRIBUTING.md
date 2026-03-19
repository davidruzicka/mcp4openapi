# Contributing to mcp4openapi

Thank you for considering contributing! This document provides guidelines for developers working on the codebase.

## Development Setup

1. **Clone and install**:
   ```bash
   git clone https://github.com/davidruzicka/mcp4openapi.git
   cd mcp4openapi
   npm install
   ```

2. **Build**:
   ```bash
   npm run build
   ```

3. **Run tests**:
   ```bash
   npm test
   ```

4. **Run with example**:
   ```bash
   export MCP4_OPENAPI_SPEC_PATH=./profiles/gitlab/openapi.yaml
   export MCP4_PROFILE_PATH=./profiles/gitlab/developer-profile-oauth.json
   export MCP4_API_BASE_URL=https://your-gitlab-instance/api/v4
   export MCP4_API_TOKEN=your-token
   npm start
   ```

## Code Style

- Follow existing TypeScript conventions
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Include "Why" comments for non-obvious decisions

## Testing

- Write tests for new important features
- Maintain test coverage above 80%
- Run `npm test` before submitting PR
- Integration tests in `src/testing/`
- Unit tests alongside source files (`*.test.ts`)
- Adding a profile requires a matching `*.test.json` in the same directory (coverage gate enforces this).

## ⚠️ CRITICAL: Profile Schema Synchronization

**When modifying profile schema structure** (adding fields to `ToolDefinition` or `Profile`):

### Two schemas MUST stay in sync:

1. **TypeScript Types** (`src/types/profile.ts`) - **Source of Truth**
   ```typescript
   export interface ToolDefinition {
     // ... existing fields ...
     new_field?: SomeType;
   }
   ```

2. **JSON Schema** (`profile-schema.json`) - **Manual Update Required**
   ```json
   {
     "properties": {
       "new_field": {
         "type": "...",
         "description": "..."
       }
     }
   }
   ```

3. **Zod Schema** (`src/generated-schemas.ts`) - **Auto-generated**
   - Automatically generated from TypeScript types
   - Run `npm run generate-schemas` or `npm run build`
   - No manual updates needed!

### Workflow

1. **Edit** `src/types/profile.ts` (add/modify interface)
2. **Run** `npm run generate-schemas` (auto-generates Zod schemas)
3. **Update** `profile-schema.json` manually (for IDE autocomplete)
4. **Test** with `npm test`

### Why This Approach?

- **TypeScript Types**: Single source of truth, compile-time checking
- **JSON Schema**: Enhanced IDE autocomplete for `.json` files (better than generated)
- **Zod Schema**: Runtime validation, auto-generated = always in sync!

### Auto-Generation Details

The `npm run generate-schemas` script:
- Uses `ts-to-zod` to convert TypeScript → Zod
- Writes to `src/generated-schemas.ts`
- Runs automatically during `npm run build`
- Skips JSON Schema (maintained manually for better IDE experience)

### Debugging Checklist

If a profile field is ignored at runtime:

1. Check TypeScript interface in `src/types/profile.ts`
2. Run `npm run generate-schemas` to regenerate Zod schemas
3. ⚠️ **Check JSON Schema in `profile-schema.json`** ← Manual updates may lag
4. ⚠️ Check for custom Zod refinements in `src/profile-loader.ts` (edge cases)

## Architecture Overview

See [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for detailed architecture and design decisions.

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Build (`npm run build`)
6. Commit with clear message
7. Push to your fork
8. Open a Pull Request

## Issue Labels and Autonomous Maintenance

This repository uses a small label taxonomy so maintainers and autonomous agents can make low-risk decisions without re-triaging every issue from scratch. See [`docs/AUTONOMOUS-AGENTS.md`](./docs/AUTONOMOUS-AGENTS.md) for the current multi-agent workflow, metadata format, evaluator behavior, and merge gates.

### Autonomy gate labels

Issue labels:
- `agent:safe`: Issue is currently eligible for autonomous handling.
- `agent:needs-plan`: Eligible issue is waiting for planner output.
- `agent:planned`: Planner produced a current acceptable plan and the issue remains eligible.
- `agent:implementing`: Implementor lease is active.
- `agent:blocked`: Automation should stop pending human help or an external dependency.
- `human:hold`: Human explicitly paused automation.

PR labels:
- `agent:created`: PR was opened by automation.
- `agent:review:required`: PR needs reviewer processing.
- `agent:review:in-progress`: Reviewer lease is active.
- `agent:review:done`: Review completed for the current lane; metadata must still match the current head SHA.
- `agent:ready-to-merge`: Deterministic merge gates currently pass.
- `agent:blocked`: PR is blocked for automation.
- `human:hold`: Human explicitly paused merge automation.

Legacy review labels still tolerated during migration:
- `agent:reviewing`
- `agent:reviewed`

### Problem-type labels

- `security`: Security bug, hardening gap, or validation/auth correctness issue.
- `refactor`: Localized structural cleanup that reduces complexity without changing intended behavior.
- `duplication`: Repeated logic, duplicated constraints, or parallel implementations that should be consolidated.
- `tests`: Missing regression coverage, edge-case coverage, or weak failure-path validation.
- `architecture`: Separation-of-concerns, boundary, dependency-direction, or extensibility problem.

### Minimal label model

The minimum recommended label model for issue triage and multi-agent maintenance is:

- **Issue shape**: `bug`, `enhancement`, `documentation`, `question`
- **Agent routing**: `agent:safe`, `agent:needs-plan`
- **Dominant problem type**: `security`, `architecture`, `duplication`
- **Resolution / closure**: `duplicate`, `invalid`, `wontfix`
- **Human / community only**: `good first issue`, `help wanted`

`refactor` and `tests` are useful optional refinements when maintainers want tighter routing for small implementation-ready issues.

### Working rules

- Autonomous issue-to-PR automation should only advance issues that satisfy the state-machine rules in [`docs/AUTONOMOUS-AGENTS.md`](./docs/AUTONOMOUS-AGENTS.md).
- Planner / implementor / reviewer / merger behavior should follow the metadata, migration, and merge-gate rules in [`docs/AUTONOMOUS-AGENTS.md`](./docs/AUTONOMOUS-AGENTS.md).
- The current implementor workflow runtime is a safe orchestration layer that expects a configured external command/backend via `IMPLEMENTOR_COMMAND`; the default workflow backend is the built-in Codex wrapper (`node dist/scripts/run-implementor-codex.js`), and if any backend omits visible PR disclosure, the runtime backfills it before review.
- Evaluator comments are non-operational and must be ignored by other automation when `agent-id: evaluator` or `ignore-for-workflow: true` is present.
- Newly discovered low-risk improvement issues should include `agent:safe` plus exactly one dominant problem-type label when possible.
- If a finding is worthwhile but still needs deeper analysis or design, prefer `agent:needs-plan` or `agent:blocked` instead of forcing it into an implementation-ready state.
- Reserve `good first issue` and `help wanted` for human/community coordination, not as automation gates.
- When in doubt, leave the issue for human triage instead of over-labeling it as safe.

## Release Process

For maintainers releasing new versions, see [`docs/RELEASING.md`](./docs/RELEASING.md).

## Documentation

When adding features:

- Update `IMPLEMENTATION.md` for architectural changes
- Keep `docs/PROFILE-GUIDE.md` in sync with profile schema
- Add or update examples in `profiles/` if applicable
- Update relevant docs in `README.md` and other `docs/` files
- Remove implemented feature from `TODO.md`

## Questions?

- Check [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for architecture details
- Check [`docs/PROFILE-GUIDE.md`](./docs/PROFILE-GUIDE.md) for profile creation
- Open an issue for discussion

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
