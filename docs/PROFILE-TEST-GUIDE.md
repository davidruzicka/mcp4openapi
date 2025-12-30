# Profile Test Guide

This guide explains how to write schema-driven profile tests using `*.test.json` files. The tests validate behavior, request shape, and coverage for each profile.

## Goals

- Ensure every profile action is covered or explicitly skipped with a reason.
- Validate request shape including path, query, headers, and body.
- Exercise profile rules such as parameter aliases, response fields, proxy downloads, and metadata exclusion.

## Key Files

- Test schema: `src/testing/test-schema.ts`
- Generic runner: `src/testing/generic-profile.test.ts`
- Coverage gate: `src/testing/profile-test-coverage.test.ts`
- Mock engine: `src/testing/dynamic-mock-server.ts`
- Test loader and validation: `src/testing/test-loader.ts`

## File Layout

Place `*.test.json` in the same directory as the profile JSON:

```
profiles/<api-name>/profile.json
profiles/<api-name>/profile.test.json
```

The coverage gate expects at least one test definition per profile directory.

## Test Definition Structure

Top-level fields:

- `$schema` optional path to `src/testing/test-schema.ts`
- `profile_name` optional profile name for sanity check
- `variables` optional template variables for reuse
- `global_mocks` optional default mocks for all scenarios
- `scenarios` list of scenario definitions
- `coverage` coverage rules for actions and request assertions

### Scenario Fields

- `name` scenario name
- `tool` MCP tool name
- `arguments` tool arguments
- `mocks` scenario-specific mock overrides
- `expect` expectations for success, result, and request shape
- `timeout_ms` optional per-scenario timeout

### Expectations

`expect` supports:

- `success` default true
- `result` partial match result
- `result_exact` strict deep equality result
- `error_code` error code when `success: false`
- `error_message_regex` regex for error message
- `request` single request expectation
- `requests` ordered sequence of request expectations
- `allow_additional_requests` allow extra captured requests

## Coverage Rules

Use `coverage` to enforce action and request coverage:

```
{
  "coverage": {
    "require_all_actions": true,
    "skip_actions": {
      "tool.action": "Reason",
      "action": "Reason"
    },
    "require_request_assertions": true,
    "skip_request_assertions": {
      "scenario name": "Reason",
      "tool.action": "Reason",
      "tool": "Reason"
    }
  }
}
```

### Destructive Actions

Destructive actions are enforced even when `require_all_actions` is false. Actions containing these tokens must be covered or skipped:

```
delete, remove, revoke, cancel, reset, terminate, destroy, purge
```

## Request Assertions

Request assertions validate what the tool actually sends to the API.

### Supported Fields

- `method` HTTP method
- `path` exact path
- `path_regex` regex for path
- `origin` exact origin
- `origin_regex` regex for origin
- `query` expected query params and values
- `query_absent` query params that must not be present
- `query_regex` regex match for query values
- `headers` expected headers
- `headers_absent` headers that must not be present
- `headers_regex` regex match for header values
- `body` partial body match
- `body_exact` strict body equality
- `body_regex` regex match for stringified body

### Single vs Sequence

- Use `expect.request` for a single request.
- Use `expect.requests` for ordered sequences.
- Set `allow_additional_requests` to allow extra traffic beyond expectations.

### Negative Assertions

Use `query_absent` and `headers_absent` to confirm metadata or sensitive values are not sent.

## Templates and Variables

Use `variables` and `{{variable}}` interpolation in arguments, mocks, and expectations. Example:

```
"variables": { "projectId": "123" }
"path": "/projects/{{projectId}}"
```

## Mocks

Mocks can target OpenAPI operation IDs or raw paths:

```
{
  "operationId": "getApiV4ProjectsId",
  "response": { "status": 200, "body": { "id": 1 } }
}
```

Or:

```
{
  "path": "/projects/123",
  "method": "GET",
  "response": { "status": 200, "body": { "id": 1 } }
}
```

## Critical Request Coverage

When `require_request_assertions` is true, request assertions are required for scenarios that use:

- Parameter aliases
- `send_response_fields_as_param`
- Proxy download operations
- Custom `metadata_params` beyond `action` and `resource_type`

If a scenario is intentionally excluded, add a reason in `skip_request_assertions`.

## Example Scenario

```
{
  "name": "Issues - List",
  "tool": "manage_issues",
  "arguments": {
    "action": "list",
    "project_id": "{{projectId}}",
    "state": ["opened", "closed"]
  },
  "mocks": [
    {
      "operationId": "getApiV4ProjectsIdIssues",
      "response": { "body": [{ "id": 1, "title": "Bug" }] }
    }
  ],
  "expect": {
    "success": true,
    "result": [{ "title": "Bug" }],
    "request": {
      "method": "GET",
      "path": "/projects/{{projectId}}/issues",
      "query": { "state[]": ["opened", "closed"] }
    }
  }
}
```

## Running Tests

Run unit tests:

```
npm run test:unit -- src/testing/generic-profile.test.ts
```

Run all tests:

```
npm test
```
