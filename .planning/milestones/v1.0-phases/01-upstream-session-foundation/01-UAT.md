---
status: complete
phase: 01-upstream-session-foundation
source: [01-04-SUMMARY.md, 01-05-SUMMARY.md]
started: 2026-03-30T08:20:00Z
updated: 2026-03-30T08:30:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Credential model — direct token passthrough
expected: |
  buildAuthHeaders accepts (provider, token: string | undefined) directly — no UpstreamCredentials wrapper.
  getOrConnect accepts token: string | undefined directly.
  upstream-credential-extractor.ts and UpstreamCredentialStore class no longer exist.
  SessionData has no upstreamCredentials field.
  Passing a plain token string to buildAuthHeaders returns {"Authorization": "Bearer <token>"}.
result: pass
note: custom-header auth type also supported (returns {[header_name]: token}) — test expected bearer only

### 2. Bearer token redaction with diagnostic suffix
expected: |
  sanitizeAuthErrorMessage applied to a string containing "Authorization: Bearer ghp_sometoken1234567890"
  produces "Authorization: Bearer [REDACTED]...7890" — last 4 chars preserved.
  Structured log field redaction (redactString) still fully redacts with no suffix.
  JWT-format tokens are redacted as [REDACTED_JWT], not matched by the Bearer regex.
result: pass

### 3. Early upstream auth validation at session init
expected: |
  A profile with upstream_mcp.validation_endpoint set causes validateCredentials() to fire
  during the MCP initialize handshake (isInitialization block in http-transport).
  A 401 from the validation endpoint returns HTTP 401 to the client with an UpstreamAuthError.
  A network failure / SSRF-blocked URL returns HTTP 502.
  A profile without validation_endpoint skips validation entirely (no-op, no HTTP call made).
result: pass

## Summary

total: 3
passed: 3
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

[none yet]
