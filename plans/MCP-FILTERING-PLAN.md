# MCP Filtering Plan

## Goal
- [ ] Introduce session-scoped parameter filtering for HTTP transport via the
  `X-Mcp4-Filtering` header to constrain automated AI tools to specific entities
  without changing profiles.

## Header format
- [ ] Header is a comma-separated list of items
- [ ] Item is `key=value` or just `key` for control keys
- [ ] Surrounding whitespace is allowed
- [ ] Values containing spaces or commas must be percent-encoded
- [ ] Key must match: `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`

Example:
```
X-Mcp4-Filtering: resource_id=123, resource_id=456, child_id=8, _allow_read
```

## AND and OR logic
- [ ] AND across different keys
- [ ] OR across the same key (repeated key forms an allowed set)

Example:
- `resource_id=123, resource_id=456` => resource 123 or 456
- `resource_id=123, child_id=8` => record 8 within resource 123

## Control keys
- [ ] `_allow_list` and `_allow_read` are control keys
- [ ] Presence is enough (no value)
- [ ] Never map to OpenAPI parameters
- [ ] `_allow_list` allows list operations without required filter params
- [ ] `_allow_read` allows read operations without required filter params

## List vs read detection
- [ ] GET without path params => list
- [ ] GET with path params => read
- [ ] Fallback based on `action`:
  - `list` or `search` => list
  - `get` or `read` => read
- [ ] If ambiguous, treat as read (stricter)

## Session-scoped rules
- [ ] Filter is set on the initialize request and applies for the full session
- [ ] After initialize:
  - if the header is sent again and differs, return an error
  - if the header is omitted, use the stored session filter

## Key to parameter mapping
- [ ] Allowed keys are `toolDef.parameters` and their aliases from
  `profile.parameter_aliases`
- [ ] Alias maps to the canonical key and is treated as equivalent
- [ ] Filter applies to a tool if there is an intersection between:
  - filter keys
  - tool parameters
  - parameter aliases

## Enforcement rules
- [ ] Filter never injects parameters, it only restricts
- [ ] If filter applies and the matching param is missing in arguments, reject
  (AuthorizationError) unless `_allow_list` or `_allow_read` applies
- [ ] If arg value is an array, all elements must be in the allowed set
- [ ] If arg value is an object, reject

## Max values per key
- [ ] Limit number of values for repeated keys
- [ ] Environment variable: `MCP4_FILTER_MAX_VALUES`
- [ ] Default: 10

## Conflicts and ambiguity
- [ ] Do not introduce any API-specific logic
- [ ] Resolve conflicts only via generic filter rules and tool parameters
- [ ] If filter is active and requires a param missing in arguments, reject unless
  `_allow_list` or `_allow_read` applies
- [ ] If filter is active and arguments contain a value outside the allowed set,
  reject as a conflict

## Alternative: Dependency derivation from MCP profile
- [ ] Use only MCP profile data, no API-specific knowledge
- [ ] For each tool and action, derive required params from:
  - `parameters.*.required`
  - `parameters.*.required_for` (for specific `action`)
- [ ] If the filter contains a key that is required for the action, require
  explicit presence in arguments (or `_allow_list`/`_allow_read`)
- [ ] If the filter does not include a required key, behavior is unchanged

## Error messages (typed errors)
- [ ] Every client-facing error must include a correlation ID, and the same ID
  must appear in server logs
- [ ] Invalid format:
  - `ValidationError: Invalid X-Mcp4-Filtering header. Expected comma-separated key=value pairs.`
- [ ] Unknown key:
  - `ValidationError: Unknown filter key 'foo'. Allowed keys: ...`
- [ ] Conflict:
  - `AuthorizationError: Filter conflict for 'param_name': expected one of [value1, value2], got 'value3'.`
- [ ] Missing required param:
  - `AuthorizationError: Filter requires parameter 'param_name' for tool 'tool_name'.`
- [ ] Header mismatch after initialize:
  - `ValidationError: X-Mcp4-Filtering header mismatch for existing session.`
- [ ] Forbidden API-specific dependency:
  - `ConfigurationError: Filter dependency resolution requires API-specific knowledge; use profile-driven required params.`
- [ ] Missing required param from profile-derived dependencies:
  - `AuthorizationError: Filter requires parameter 'param_name' for tool 'tool_name' action 'action_name'.`

## Implementation impact
- [ ] `src/types/http-transport.ts`:
  - Add `filtering?: Record<string, string[]>` to `SessionData`
- [ ] `src/http-transport.ts`:
  - Parse and validate `X-Mcp4-Filtering`
  - Store on session during initialize
  - Enforce header match after initialize
- [ ] `src/mcp-server.ts`:
  - Enforce filter before executing tool
  - Use `profile.parameter_aliases`
  - Detect list/read
