# Test Profile Migration Plan

Goal: Replace hardcoded profile tests with schema-driven generic tests based on `*.test.json` definitions, while preserving coverage for profile behavior and preventing silent gaps.

Principles:
- Every profile action must be covered by at least one scenario or explicitly skipped with a reason.
- Generic tests must validate both response content and request shape (path, query, headers, body).
- Security and profile rules (aliases, required_for, response_fields, proxy downloads) must be exercised.

## Current State Summary
- Generic runner: `src/testing/generic-profile.test.ts`
- Test schema: `src/testing/test-schema.ts`
- Mock engine: `src/testing/dynamic-mock-server.ts`
- Existing schema example: `profiles/gitlab/developer-profile-oauth.test.json`
- Coverage gate: `src/testing/profile-test-coverage.test.ts`
- E2E utilities still use a standalone mock server (by design).

## Phase 1 - Make generic tests enforce profile coverage

1) Validate schema against profile
   - [x] Call `validateTestAgainstProfile()` in `generic-profile.test.ts` after loading the profile JSON.
   - [x] Fail fast if any scenario targets a missing tool or required params are missing.

2) Add coverage rules to schema
   - [x] Extend `ProfileTestDefinitionSchema` with:
     - `coverage`: { `require_all_actions`: boolean, `skip_actions`: Record<string, string> }
   - [x] For each tool, collect `operations` actions and compare with scenarios.
   - [x] If missing and not in `skip_actions`, fail the test with a clear report.

3) Add request assertion support
   - [x] Extend schema with `expect.request`:
     - `method`, `path`, `query`, `headers`, `body`
   - [x] Capture requests in `DynamicMockEngine` and assert per-scenario.
   - [x] Use this to validate:
     - `parameter_aliases` -> correct query/path usage
     - `send_response_fields_as_param` -> `fields` query
     - `array_format` -> query serialization
     - `metadata_params` -> excluded from body

Deliverable:
- Generic tests fail if any action is untested or mismatched.
- Test schema is now a real contract.

## Phase 2 - Cover profile rules in schema scenarios

4) Required/conditional params
   - [x] Add scenarios where required params are missing and expect validation errors.
   - [x] Add success scenarios that include `required_for` params.

5) Response fields and filtering
   - [x] Add scenarios that validate `fields` query presence and filtered response output.
   - [x] Include nested selectors and ensure unexpected fields are removed.

6) Proxy download behavior
   - [x] Add schema support for multi-request flows or composite mocks:
     - metadata endpoint -> download URL -> download response
   - [x] Validate:
     - [x] same-origin enforcement
     - [x] `skip_auth` behavior
     - [x] `allowed_hosts`
     - [x] redirect limits

7) Composite tools
   - [x] Add scenario support for composite steps:
     - `steps`, `store_as`, `depends_on`
     - `partial_results` error behavior

Deliverable:
- Schema covers all profile-level rules that can cause runtime bugs.

## Phase 3 - Migrate profiles (one by one)

8) GitLab profile
   - [x] Expand `profiles/gitlab/developer-profile-oauth.test.json` to cover all tool actions.
   - [x] Use `expect.request` to assert parameter mapping and metadata exclusion.
   - [x] Keep E2E transport tests; remove redundant hardcoded mocks.
   - [x] Replace `src/testing/mock-gitlab-server.ts` usage where possible.
   - [x] Remove plain bearer GitLab profile and keep only OAuth variant.
     - [x] Delete `profiles/gitlab/developer-profile.json` and its test file.
     - [x] Add `profiles/gitlab/developer-profile-oauth.test.json` based on existing scenarios.
     - [x] Update all references in tests and docs to use the OAuth profile.
     - [ ] Extend coverage gate to require a `.test.json` per profile JSON (not just per directory).

9) YouTrack profile
   - [x] Add `profiles/youtrack/profile.test.json` (new).
   - [x] Cover:
     - response_fields for nested content
     - proxy download flows
     - project custom fields
   - [x] Replace `src/testing/youtrack-integration.test.ts` with schema tests (file not present).

10) Semgrep or other profiles
   - [x] Add `*.test.json` per profile.
   - [x] Ensure full action coverage or explicit skips.

Deliverable:
- Each profile has a schema test file with complete action coverage.

## Phase 4 - Enforce coverage in CI

11) Add a CI gate
   - [x] New test or script that verifies:
     - every profile has a `*.test.json`
     - no uncovered actions remain

12) Remove legacy tests
   - [x] Remove or simplify hardcoded profile tests that are fully superseded.
   - [x] Keep low-level unit tests (schema validator, parser, errors).

## Phase 5 - Remaining gaps for full migration

13) Enforce coverage for composite tools (no `operations`)
   - [x] Update coverage to treat each composite tool as a required action.
     - [x] Add a coverage key for composite tools (e.g., `tool.name`).
     - [x] Allow `skip_actions` to reference composite tools by name.
     - [x] Add tests in `src/testing/test-loader.test.ts` to cover composite enforcement.

14) Require request-shape assertions for critical scenarios only
   - [x] Extend schema with coverage rules like `require_request_assertions` and `skip_request_assertions`.
   - [x] Enforce in `validateTestAgainstProfile()` that scenarios include `expect.request` or `expect.requests` when required.
   - [x] Define "critical" as: parameter_aliases, send_response_fields_as_param, proxy download, metadata exclusion checks.
   - [x] Add negative cases in `src/testing/test-loader.test.ts`.

15) Add negative request assertions for metadata exclusion
   - [x] Extend `RequestExpectationSchema` with `query_absent` and `body_exact`.
   - [x] Implement checks in `assertSingleRequestMatch()` to validate absence and exact body matches.
   - [x] Add request-assertion unit tests for absence and exact matches.
   - [ ] Use in profile tests to verify `metadata_params` are excluded from body.

16) Validate `array_format` behavior in schema tests
   - [ ] Add at least one scenario per profile that uses array parameters.
   - [ ] Assert serialized query shape for `array_format` (e.g., brackets) via `expect.request.query`.

17) Remove `result_schema` from test schema
   - [x] Remove from `src/testing/test-schema.ts`.
   - [ ] Remove any mention from docs or plans if present.

18) Enforce destructive action coverage
   - [ ] Define destructive actions per tool (e.g., `delete`, `remove`, `revoke`, `cancel`, `reset`, `terminate`) in `validateTestAgainstProfile()` or a helper.
   - [ ] Require scenarios for destructive actions unless explicitly skipped with a reason in `skip_actions`.
   - [ ] Add tests in `src/testing/test-loader.test.ts` for destructive enforcement and skip reasons.

19) Add regex request assertions (opt-in)
   - [x] Extend `RequestExpectationSchema` with `path_regex`, `origin_regex`, `headers_regex`, `query_regex`, `body_regex`.
   - [x] Implement regex matching in `assertSingleRequestMatch()` (only when corresponding `*_regex` is provided).
   - [x] Add unit tests in `src/testing/request-assertions.test.ts` for regex pass/fail cases.

## Suggested Sequence (Minimum Viable)
1) Add coverage enforcement to generic runner.
2) Add request assertions to schema + mock engine logging.
3) Expand GitLab schema to full action coverage.
4) Add YouTrack schema file and replace integration test.
5) Apply to remaining profiles.
