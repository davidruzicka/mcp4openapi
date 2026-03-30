---
status: complete
phase: 02-tool-discovery-and-call-proxy
source: [02-01-SUMMARY.md, 02-02-SUMMARY.md, 02-03-SUMMARY.md]
started: 2026-03-30T14:30:00Z
updated: 2026-03-30T14:35:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Profile rejects upstream_mcp + tools[] combination
expected: Loading a profile that defines both upstream_mcp (or upstream_mcp_from_env) AND a non-empty tools[] array fails at profile load time with a ValidationError whose message contains "mutually exclusive". A profile with only upstream_mcp (empty tools[]) loads successfully. Run: npm test -- -t "mutually exclusive"
result: pass

### 2. Tool sanitizer drops tools with invalid names/descriptions
expected: When an upstream server returns a tool list containing names with special chars (e.g. "bad<name>", "script`exec`") or descriptions containing <, >, or backtick, sanitizeToolList removes those tools from the list. Only tools with names matching [a-zA-Z0-9_-] and clean descriptions survive. Run: npm test -- -t "sanitize"
result: pass

### 3. tools/list proxied to upstream when upstream_mcp configured
expected: A session using a profile with upstream_mcp set will call the upstream MCP server's tools/list endpoint and return its (sanitized) tool list to the downstream client. Without upstream_mcp, the local tools[] are returned instead. Run: npm test -- -t "upstream tools/list\|handleUpstreamToolsList"
result: pass

### 4. tools/call forwarded to upstream with typed error mapping
expected: A tools/call request for a tool served by the upstream MCP server is forwarded to that server and its response returned to the client. If the upstream call throws a timeout, the client receives a -32001 JSON-RPC error. If upstream returns isError:true, it is forwarded as-is (not converted to a JSON-RPC error). Run: npm test -- -t "upstream tools/call\|handleUpstreamToolCall\|error mapping"
result: pass

### 5. tools/list_changed notification forwarded to downstream SSE
expected: When the upstream MCP server sends a ToolListChanged notification, the downstream SSE client receives it in real-time (not buffered) if its SSE stream is active. Run: npm test -- -t "notification\|ToolListChanged\|drainNotifications"
result: pass

### 6. Notifications queued and replayed on SSE reconnect
expected: When the downstream SSE stream is inactive and upstream sends a ToolListChanged notification, the notification is held in a bounded per-session queue (max 50, 5-min TTL). On SSE reconnect, the queue is drained and all buffered notifications are replayed. Notifications older than 5 minutes are discarded. Run: npm test -- -t "queue\|drain\|reconnect\|buffered"
result: pass

## Summary

total: 6
passed: 6
issues: 0
pending: 0
skipped: 0

## Gaps

[none yet]
