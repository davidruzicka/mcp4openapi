---
name: create-crud-mcp-profile
description: Create a new CRUD MCP profile from an OpenAPI spec in this repository. Use when a user asks for a profile equivalent to existing CRUD-style profiles (for example YouTrack, Grafana, GitLab, GitHub Security), including action mapping, parameter modeling, profile tests, docs updates, and validation.
---

# CRUD MCP Profile Builder

Build a production-ready profile in `profiles/<api>/` without rediscovering repository conventions.

## Load This Context First
Read only these sources first, in this order:
1. `AGENTS.md` (canonical rules and workflow constraints)
2. `IMPLEMENTATION.md` (architecture intent)
3. `docs/PROFILE-GUIDE.md` (profile structure and patterns)
4. `docs/PROFILE-TEST-GUIDE.md` (schema-driven tests)
5. A strong local reference profile:
   - `profiles/youtrack/profile.json` for CRUD grouping style
   - `profiles/github-security/profile.json` for compact two-tool pattern
6. Target spec and folder:
   - `profiles/<api>/openapi.*` or equivalent file present in folder

Then inspect only relevant docs for updates:
- `README.md` profile lists/sections
- `CHANGELOG.md` (`[Unreleased]`)
- `TODO.md` only if you are implementing an existing backlog item

For repeatable command snippets, use `references/discovery-and-validation.md`.

## Expected Output
Create or update these files:
1. `profiles/<api>/profile.json`
2. `profiles/<api>/profile.test.json`
3. `README.md` (profile list and profiles section)
4. `CHANGELOG.md` (single-line user-facing entry in `Unreleased`)

Optional:
- Fix invalid OpenAPI syntax in the bundled spec if parser/validator fails (for example invalid `items` shape).

## Workflow
1. Inventory the target spec.
2. Build operation map from `operationId` + HTTP method + path.
3. Decide CRUD grouping based on available methods:
   - `retrieve_content` for GET-like reads
   - `create_content` for POST creates
   - `update_content` for PATCH/PUT/POST updates
   - `delete_content` for DELETE removes
   - If API is read-heavy, keep only meaningful groups (do not add empty tools).
4. Define action names that are explicit and stable (for example `list_*`, `get_*`, `create_*`, `update_*`, `delete_*`).
5. Generate parameter model from OpenAPI:
   - `required: true` for parameters required by all actions in a tool
   - `required_for` for action-specific required parameters
   - include useful optional filters
   - add `parameter_aliases` for common ergonomic names (`owner`, `repo`, `project_id`, etc.)
6. Set interceptors:
   - bearer auth with API-specific env var name (for example `CODECOV_TOKEN`)
   - base URL env var + sane default when known
   - retry policy aligned with existing profiles when applicable
7. Build `profile.test.json` with schema-driven scenarios:
   - one scenario per action minimum
   - `coverage.require_all_actions: true`
   - add request assertions when behavior is non-trivial (aliases, metadata params, response field forwarding, proxy download)
8. Validate and test.
9. Update docs (`README.md`, `CHANGELOG.md`).

## Decision Rules
- Prefer consistency with existing repository profile style over inventing new naming conventions.
- Do not force full CRUD when the API does not provide full CRUD endpoints.
- Keep `metadata_params` minimal. Do not mark parameters as metadata if they must be forwarded as query/body in any action.
- If a parameter name is reused in multiple locations (for example `path` as both path and query parameter), avoid metadata suppression that would break query forwarding.
- Keep descriptions practical for model usage, not API-spec copy-paste.

## Validation Gate (Definition of Done)
Run all of the following:
1. `npm run validate -- profiles/<api>/profile.json profiles/<api>/<spec-file>`
2. `npm run test:unit -- src/testing/generic-profile.test.ts`
3. `npm run typecheck`

If profile-only work is large, suggest (not force):
- `npm audit`

## Failure Handling
- If validator fails due to malformed bundled spec, fix the spec in place with minimal safe change and rerun validation.
- If test coverage fails, add missing action scenario rather than weakening coverage.
- If operation mapping is ambiguous, inspect the OpenAPI path+method block directly and prefer explicit action naming.

## Completion Output Pattern
Report:
1. Files created/updated
2. CRUD coverage summary (tool count + action count)
3. Validation/test/typecheck results
4. Proposed Conventional Commit message
