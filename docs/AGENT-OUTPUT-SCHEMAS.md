# Agent Output Schemas

This document describes the machine-readable JSON contracts used by the autonomous issue-to-PR workflow.

## Scope

The autonomous workflow relies on strict structured outputs for agent handoff and orchestration. These contracts are intentionally narrow so the runtime can reject malformed, stale, or over-permissive payloads deterministically.

Current documented schema modules:

- `src/automation/implementor-command-result.ts` - implementor backend result returned by the Codex wrapper and parsed by the orchestration layer

## Source of truth and validation model

For agent-output schemas, the source of truth lives in TypeScript modules close to the runtime code that consumes them.

For the implementor result contract:

- TypeScript interface: `ImplementorCommandResult`
- Runtime JSON schema: `implementorCommandResultJsonSchema`
- Runtime parser/validator: `parseImplementorCommandResult(...)`

Validation characteristics:

- strict JSON object only
- `additionalProperties: false`
- `summary` must be a non-empty string
- `pullRequest` is required only for `outcome: "pr-created"`
- `pullRequest` is forbidden for `outcome: "failed"` and `"blocked"`

## Implementor command result schema

Purpose:

- hand off the final result of an implementor backend run to the label/state reconciler
- keep PR creation metadata machine-readable
- fail closed when the backend emits prose, markdown fences, or schema-invalid JSON

### Allowed outcomes

- `pr-created`
- `failed`
- `blocked`

### Shape

```json
{
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["outcome", "summary", "pullRequest"],
      "properties": {
        "outcome": { "const": "pr-created" },
        "summary": { "type": "string", "minLength": 1 },
        "pullRequest": {
          "type": "object",
          "additionalProperties": false,
          "required": ["number", "url"],
          "properties": {
            "number": { "type": "integer" },
            "url": { "type": "string", "minLength": 1 }
          }
        }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["outcome", "summary"],
      "properties": {
        "outcome": { "enum": ["failed", "blocked"] },
        "summary": { "type": "string", "minLength": 1 }
      }
    }
  ]
}
```

### Valid examples

PR created:

```json
{
  "outcome": "pr-created",
  "summary": "Implemented the requested change and opened a pull request with tests.",
  "pullRequest": {
    "number": 123,
    "url": "https://github.com/davidruzicka/mcp4openapi/pull/123"
  }
}
```

Failed safely:

```json
{
  "outcome": "failed",
  "summary": "npm test failed after the code change and no safe auto-fix was identified."
}
```

Blocked:

```json
{
  "outcome": "blocked",
  "summary": "The issue requires human clarification before a safe implementation plan can continue."
}
```

### Invalid examples

Extra field rejected:

```json
{
  "outcome": "failed",
  "summary": "Tests failed.",
  "details": "extra field not allowed"
}
```

Missing `pullRequest` for `pr-created`:

```json
{
  "outcome": "pr-created",
  "summary": "Opened a PR."
}
```

Forbidden `pullRequest` for `blocked`:

```json
{
  "outcome": "blocked",
  "summary": "Waiting for approval.",
  "pullRequest": {
    "number": 123,
    "url": "https://github.com/davidruzicka/mcp4openapi/pull/123"
  }
}
```

## Operational guidance

- Backend prompts should instruct the model/tool to return exactly one JSON object and no surrounding prose.
- Orchestration code should parse through the shared validator, not ad-hoc field checks.
- If new agent-output schemas are added for planner/reviewer/merger stages, document them here and link the canonical source modules.

## Related documents

- [Autonomous Agents](./AUTONOMOUS-AGENTS.md)
- [README](../README.md)
- `src/automation/implementor-command-result.ts`