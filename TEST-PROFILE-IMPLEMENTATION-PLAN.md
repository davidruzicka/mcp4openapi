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
- Existing schema example: `profiles/gitlab/developer-profile.test.json`
- Still hardcoded: `src/testing/mock-gitlab-server.ts`, `src/testing/youtrack-integration.test.ts`, plus E2E utilities.

## Phase 1 - Make generic tests enforce profile coverage

1) Validate schema against profile
   - [ ] Call `validateTestAgainstProfile()` in `generic-profile.test.ts` after loading the profile JSON.
   - [ ] Fail fast if any scenario targets a missing tool or required params are missing.

2) Add coverage rules to schema
   - [ ] Extend `ProfileTestDefinitionSchema` with:
     - `coverage`: { `require_all_actions`: boolean, `skip_actions`: Record<string, string> }
   - [ ] For each tool, collect `operations` actions and compare with scenarios.
   - [ ] If missing and not in `skip_actions`, fail the test with a clear report.

3) Add request assertion support
   - [ ] Extend schema with `expect.request`:
     - `method`, `path`, `query`, `headers`, `body`
   - [ ] Capture requests in `DynamicMockEngine` and assert per-scenario.
   - [ ] Use this to validate:
     - `parameter_aliases` -> correct query/path usage
     - `send_response_fields_as_param` -> `fields` query
     - `array_format` -> query serialization
     - `metadata_params` -> excluded from body

Deliverable:
- Generic tests fail if any action is untested or mismatched.
- Test schema is now a real contract.

## Phase 2 - Cover profile rules in schema scenarios

4) Required/conditional params
   - [ ] Add scenarios where required params are missing and expect validation errors.
   - [ ] Add success scenarios that include `required_for` params.

5) Response fields and filtering
   - [ ] Add scenarios that validate `fields` query presence and filtered response output.
   - [ ] Include nested selectors and ensure unexpected fields are removed.

6) Proxy download behavior
   - [ ] Add schema support for multi-request flows or composite mocks:
     - metadata endpoint -> download URL -> download response
   - [ ] Validate:
     - same-origin enforcement
     - `skip_auth` behavior
     - `allowed_hosts`
     - redirect limits

7) Composite tools
   - [ ] Add scenario support for composite steps:
     - `steps`, `store_as`, `depends_on`
     - `partial_results` error behavior

Deliverable:
- Schema covers all profile-level rules that can cause runtime bugs.

## Phase 3 - Migrate profiles (one by one)

8) GitLab profile
   - [ ] Expand `profiles/gitlab/developer-profile.test.json` to cover all tool actions.
   - [ ] Use `expect.request` to assert parameter mapping and metadata exclusion.
   - [ ] Keep E2E transport tests; remove redundant hardcoded mocks.
   - [ ] Replace `src/testing/mock-gitlab-server.ts` usage where possible.

9) YouTrack profile
   - [ ] Add `profiles/youtrack/profile.test.json` (new).
   - [ ] Cover:
     - response_fields for nested content
     - proxy download flows
     - project custom fields
   - [ ] Replace `src/testing/youtrack-integration.test.ts` with schema tests.

10) Semgrep or other profiles
   - [ ] Add `*.test.json` per profile.
   - [ ] Ensure full action coverage or explicit skips.

Deliverable:
- Each profile has a schema test file with complete action coverage.

## Phase 4 - Enforce coverage in CI

11) Add a CI gate
   - [ ] New test or script that verifies:
     - every profile has a `*.test.json`
     - no uncovered actions remain

12) Remove legacy tests
   - [ ] Remove or simplify hardcoded profile tests that are fully superseded.
   - [ ] Keep low-level unit tests (schema validator, parser, errors).

## Open Questions
- Do we want to require coverage for destructive actions by default?
- Should `skip_actions` be allowed only with an explicit reason string?
- Should request assertions allow regex matching for dynamic values?

## Suggested Sequence (Minimum Viable)
1) Add coverage enforcement to generic runner.
2) Add request assertions to schema + mock engine logging.
3) Expand GitLab schema to full action coverage.
4) Add YouTrack schema file and replace integration test.
5) Apply to remaining profiles.
