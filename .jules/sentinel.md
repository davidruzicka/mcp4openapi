## 2026-01-15 - [CRITICAL] Internal Error Leakage via API Responses

**Vulnerability:**
The HTTP transport layer (handleGet and handleMetrics) was catching exceptions and returning the raw error message to the client in the JSON response body.
Example: `res.status(500).json({ error: 'Internal Server Error', message: (error as Error).message });`

**Learning:**
Even with global error handling, specific route handlers might catch errors and inadvertently expose sensitive internal details (e.g., database connection strings, file paths, or stack traces masquerading as messages).
Testing for 'error' property presence is not enough; we must verify the CONTENT of the error message is sanitized.

**Prevention:**
1. Always use a generic error message for 500 responses exposed to clients.
2. Use a unique Correlation ID to link the client-facing generic error with the detailed server-side log.
3. Tests should assert that sensitive error details are NOT present in the response body.

## 2026-01-24 - [HIGH] Unbounded OAuth State Storage

**Vulnerability:**
The `ExternalOAuthProvider` used in-memory maps (`stateStore`, `authorizationCodes`, `accessTokens`) without any expiration or cleanup mechanism. This allowed an attacker to trigger memory exhaustion (DoS) by initiating many authorization flows without completing them.

**Learning:**
In-memory stores for temporary security state (like OAuth nonces/states) must always have a TTL (Time-To-Live) and a proactive cleanup mechanism. Relying on the "happy path" to delete entries is insufficient.

**Prevention:**
1.  Add `createdAt` timestamps to all in-memory state objects.
2.  Implement a `cleanup()` method that iterates and removes expired entries.
3.  Hook this cleanup method into a global interval (e.g., existing session cleanup).

## 2026-01-25 - [MEDIUM] Log Injection in Console Logger

**Vulnerability:**
The `ConsoleLogger` was writing user-supplied messages directly to `stderr` without sanitization. An attacker could inject newline characters (`\n`) into a log message (e.g., via a login username or error message) to forge fake log entries, potentially confusing log analysis tools or administrators (CWE-117).

**Learning:**
Logging untrusted input to a text-based stream (like console/file) requires sanitization of control characters, especially newlines. JSON logging (`JsonLogger`) is inherently safe from this specific attack because `JSON.stringify` escapes control characters.

**Prevention:**
1.  Sanitize all log messages in text-based loggers by escaping newlines (e.g., replacing `\n` with `\\n`).
2.  Prefer structured logging (JSON) in production environments where log integrity is critical.

## 2026-01-30 - [INFO] OAuth pre-registered client for VS Code

**Finding to ignore:**
Reports claiming that `mcp-proxy-client` is not registered when env-configured OAuth client_id/client_secret are set.

**Why this is safe:**
`ExternalOAuthProvider` always pre-registers `mcp-proxy-client` unconditionally in the constructor. Env resolution only affects `config.client_id`, not the pre-registered VS Code client. Redirects are still constrained by `allowed_redirect_hosts` at runtime.

**Reviewer instruction:**
If a finding flags missing `mcp-proxy-client` registration due to env overrides, mark it as a false positive and do not require changes and continue. Only revisit if the constructor pre-registration is removed or gated.
