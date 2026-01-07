# MCP Filtering Plan

## Goal
- [x] Introduce session-scoped parameter filtering for HTTP transport via the
  `X-Mcp4-Filtering` header to constrain automated AI tools to specific entities
  without changing profiles.

## Header format
- [x] Header is a comma-separated list of items
- [x] Item is `key=value` or just `key` for control keys
- [x] Surrounding whitespace is allowed
- [x] Values containing spaces or commas must be percent-encoded
- [x] Key must match: `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`

Example:
```
X-Mcp4-Filtering: resource_id=123, resource_id=456, child_id=8, _allow_read
```

## AND and OR logic
- [x] AND across different keys
- [x] OR across the same key (repeated key forms an allowed set)

Example:
- `resource_id=123, resource_id=456` => resource 123 or 456
- `resource_id=123, child_id=8` => record 8 within resource 123

## Control keys
- [x] `_allow_list` and `_allow_read` are control keys
- [x] Presence is enough (no value)
- [x] Never map to OpenAPI parameters
- [x] `_allow_list` allows list operations without required filter params
- [x] `_allow_read` allows read operations without required filter params

## List vs read detection
- [x] GET without path params => list
- [x] GET with path params => read
- [x] Fallback based on `action`:
  - `list` or `search` => list
  - `get` or `read` => read
- [x] If ambiguous or no GET metadata, treat as modify (stricter)

## Session-scoped rules
- [x] Filter is set on the initialize request and applies for the full session
- [x] After initialize:
  - if the header is sent again and differs, return an error
  - if the header is omitted, use the stored session filter

## Key to parameter mapping
- [x] Allowed keys are `toolDef.parameters` and their aliases from
  `profile.parameter_aliases`
- [x] Alias maps to the canonical key and is treated as equivalent
- [x] Filter applies to a tool if there is an intersection between:
  - filter keys
  - tool parameters
  - parameter aliases

## Enforcement rules
- [x] Filter never injects parameters, it only restricts
- [x] If filter applies and the matching param is missing in arguments, reject
  (AuthorizationError) unless `_allow_list` or `_allow_read` applies
- [x] If arg value is an array, all elements must be in the allowed set
- [x] If arg value is an object, reject

## Max values per key
- [x] Limit number of values for repeated keys
- [x] Environment variable: `MCP4_FILTER_MAX_VALUES`
- [x] Default: 10

## Conflicts and ambiguity
- [x] Do not introduce any API-specific logic
- [x] Resolve conflicts only via generic filter rules and tool parameters
- [x] If filter is active and requires a param missing in arguments, reject unless
  `_allow_list` or `_allow_read` applies
- [x] If filter is active and arguments contain a value outside the allowed set,
  reject as a conflict

## Alternative: Dependency derivation from MCP profile
- [x] Use only MCP profile data, no API-specific knowledge
- [x] For each tool and action, derive required params from:
  - `parameters.*.required`
  - `parameters.*.required_for` (for specific `action`)
- [x] If the filter contains a key that is required for the action, require
  explicit presence in arguments (or `_allow_list`/`_allow_read`)
- [x] If the filter does not include a required key, behavior is unchanged

## Error messages (typed errors)
- [x] Every client-facing error must include a correlation ID, and the same ID
  must appear in server logs
- [x] Invalid format:
  - `ValidationError: Invalid X-Mcp4-Filtering header. Expected comma-separated key=value pairs.`
- [ ] Unknown key:
  - `ValidationError: Unknown filter key 'foo'. Allowed keys: ...`
- [x] Conflict:
  - `AuthorizationError: Filter conflict for 'param_name': expected one of [value1, value2], got 'value3'.`
- [x] Missing required param:
  - `AuthorizationError: Filter requires parameter 'param_name' for tool 'tool_name'.`
- [x] Header mismatch after initialize:
  - `ValidationError: X-Mcp4-Filtering header mismatch for existing session.`
- [x] Forbidden API-specific dependency:
  - `ConfigurationError: Filter dependency resolution requires API-specific knowledge; use profile-driven required params.`
- [ ] Missing required param from profile-derived dependencies:
  - `AuthorizationError: Filter requires parameter 'param_name' for tool 'tool_name' action 'action_name'.`

## Implementation impact
- [x] `src/types/http-transport.ts`:
  - Add `filtering?: Record<string, string[]>` to `SessionData`
- [x] `src/http-transport.ts`:
  - Parse and validate `X-Mcp4-Filtering`
  - Store on session during initialize
  - Enforce header match after initialize
- [x] `src/mcp-server.ts`:
  - Enforce filter before executing tool
  - Use `profile.parameter_aliases`
  - Detect list/read
