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
