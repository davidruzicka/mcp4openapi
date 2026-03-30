# Phase 2: Tool Discovery and Call Proxy - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-03-30
**Phase:** 02-tool-discovery-and-call-proxy
**Areas discussed:** Tool list composition, Sanitization failure behavior, Notification forwarding scope

---

## Area 1: Tool list composition

**Q:** When upstream_mcp is set in a profile, what does tools/list return?
- Options: Upstream tools only / Both merged
- **Selected:** Upstream tools only
- Rationale: Profile-per-upstream model — the whole profile IS the upstream proxy

**Q:** Should the profile loader reject a profile that has both upstream_mcp and OpenAPI tools defined?
- Options: Yes — validation error at load time / No — silently ignore OpenAPI tools
- **Selected:** Yes — validation error at load time
- Rationale: Catch misconfiguration early; upstream_mcp and tools[] are mutually exclusive

---

## Area 2: Sanitization failure behavior

**Q:** When an upstream tool name or description fails the safe-string check, what should happen?
- Options: Log warning + drop that tool / Reject the entire tools/list response / Drop silently
- **Selected:** Log warning + drop that tool
- Rationale: One bad tool from upstream should not break all tool discovery for the session

**Q:** What should the safe-string allowlist cover for tool names and descriptions?
- Options: Names alphanumeric+underscore+dash; descriptions printable ASCII excluding < > ` / Same as inbound parameter validation
- **Selected:** Names alphanumeric+underscore+dash; descriptions printable ASCII excluding < > `
- Rationale: Names match MCP spec identifier convention; descriptions block injection while preserving human-readable text

---

## Area 3: Notification forwarding scope

**Q:** Which upstream MCP notifications to forward?
- User clarified (in Czech): tools/list_changed only now, but notification code prepared for other types
- **Decision:** Forward tools/list_changed only; dispatch path designed for extension

**Q:** Queue behavior when no downstream SSE stream is attached?
- Options: Bounded queue with TTL / Unbounded queue until reconnect
- **Selected:** Bounded queue with TTL (~50 events, ~5min TTL)
- Rationale: Prevents memory growth on long disconnects

---

*Discussion completed: 2026-03-30*
