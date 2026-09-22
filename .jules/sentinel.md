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

## 2025-05-23 - [HIGH] Path Traversal in Composite Tool Execution

**Vulnerability:**
The `CompositeExecutor` substituted user-provided arguments directly into API path templates without URL encoding.
Example: `GET /projects/{id}` with `id` = `../admin` resolved to `GET /projects/../admin` -> `GET /admin`, allowing access to unintended API endpoints.

**Learning:**
String replacement for path parameters is dangerous if the input is not strictly validated or encoded. Clients often trust the server to handle encoding, but the server must ensure that substitutions into templates (especially for external APIs) are safe.

**Prevention:**
1.  Always use `encodeURIComponent()` when substituting user input into path segments.
2.  Validate that path parameters do not contain path traversal characters (like `..` or `/`) even before encoding, if strict validation is possible.

## 2026-02-04 - [HIGH] SSRF in OAuth Provider

**Vulnerability:**
The `ExternalOAuthProvider` was performing direct `fetch()` calls to URLs provided in configuration (`authorization_endpoint`, `token_endpoint`, etc.) without validation. This could allow Server-Side Request Forgery (SSRF) if a malicious profile pointed these endpoints to internal network resources (e.g., `http://127.0.0.1/admin`).

**Learning:**
Any outbound request based on user-supplied or configuration-supplied URLs must be validated against SSRF risks. Assuming that configuration is trusted is risky, especially when profiles can be shared or downloaded.

**Prevention:**
1.  Implemented `SSRFValidator` to check hostnames and IPs against a blocklist of private ranges.
2.  Integrated `SSRFValidator` into all outbound requests in `ExternalOAuthProvider`.
3.  Ensured tests mock this validation to avoid external dependencies or blocking legitimate test domains.

## 2026-02-09 - [HIGH] ReDoS in Tool Argument Validation

**Vulnerability:**
`ToolGenerator` constructed regular expressions directly from profile definitions (`new RegExp(param.pattern)`) and executed them on user input. It lacked validation for ReDoS-vulnerable patterns and trusted the `maxLength` from the profile (which could be excessively large), allowing attackers to cause denial of service via catastrophic backtracking.

**Learning:**
Never trust regex patterns from configuration (profiles) without validation, and never trust input length limits that exceed safe bounds for regex execution. Even "safe" regexes can be slow on very large strings.

**Prevention:**
1.  Enforce a hard cap (e.g., 4096 chars) on input strings validated against any regex, regardless of schema `maxLength`.
2.  Validate all regex patterns using a `RegexValidator` (checking for nested quantifiers, ambiguous alternation) before usage.

## 2026-02-15 - [MEDIUM] SSRF TOCTOU in Node.js `fetch`

**Vulnerability:**
The `SSRFValidator` resolves hostnames to verify they are not private IPs, but the subsequent `fetch()` call re-resolves the hostname. This creates a Time-of-Check Time-of-Use (TOCTOU) vulnerability where a DNS rebinding attack can bypass the check.

**Learning:**
In Node.js 18+ using the native `fetch` (based on `undici`), it is difficult to separate DNS resolution from the connection establishment while maintaining HTTPS certificate verification (SNI). Unlike `http.Agent` which allows custom lookup functions, `fetch` requires complex `Dispatcher` configuration which may not be accessible or exposed in high-level abstractions.

**Prevention:**
1.  Hardening the `SSRFValidator` to block all non-standard IP ranges (Multicast, Reserved) is a good defense-in-depth, but does not solve TOCTOU.
2.  True mitigation requires either:
    -   Using an HTTP client that supports "connect to IP, verify hostname" (e.g., `curl` style).
    -   Implementing a custom `Dispatcher` for `undici`.
    -   Disabling DNS rebinding at the resolver level (infrastructure).

## 2026-02-17 - [HIGH] XSS via OAuth Redirect Scheme

**Vulnerability:**
The `ExternalOAuthProvider` validated redirect URIs by checking the hostname against an allowlist (typically including `localhost`), but failed to validate the URI scheme (protocol). This allowed an attacker to supply a redirect URI like `javascript://localhost/%0aalert(1)`. Since the hostname (`localhost`) matched the allowlist, the server would redirect the user to this malicious URI, triggering Cross-Site Scripting (XSS).

**Learning:**
Hostname validation is insufficient for URL security because it ignores the protocol. Many dangerous schemes (like `javascript:`, `data:`, `vbscript:`) can have valid or empty hostnames that pass standard hostname checks. `new URL('javascript://localhost').hostname` returns `'localhost'`, which is misleadingly safe.

**Prevention:**
1.  Always validate the `protocol` of a URL in addition to the hostname.
2.  Explicitly block dangerous schemes (`javascript:`, `data:`, `vbscript:`, `file:`).
3.  Prefer an allowlist of safe schemes (`http:`, `https:`) and known application schemes (e.g., `vscode:`, `cursor:`) over a blocklist if possible, but definitely block known bad ones.

## 2026-02-24 - [MEDIUM] Environment Variable Leakage in Error Messages

**Vulnerability:**
`ProxyDownloadExecutor` included the raw value of an environment variable in a `ValidationError` message when the value was not a valid positive integer. If a user configured `max_size_bytes_from_env` to point to a sensitive environment variable (e.g., an API key), the secret value would be exposed in the error message.

**Learning:**
Error messages should never include raw values from sensitive sources like environment variables, even for validation errors. Configuration errors can easily lead to secrets being treated as normal values.

**Prevention:**
1.  Avoid including raw values in error messages when the source is potentially sensitive (env vars, auth headers).
2.  Use generic error messages for validation failures of sensitive data.

## 2026-08-06 - [MEDIUM] Memory Leak via Uncleared Timeout in Promise.race

**Vulnerability:**
The `mcp-server.ts` and `ssrf-validator.ts` files contained `Promise.race` blocks for timeouts where the `setTimeout` identifier was not cleared if the primary promise resolved first. This causes the Node.js event loop to keep the timer active until the timeout duration expires, potentially leading to memory leaks or Delayed DoS under high load.

**Learning:**
Any timeout mechanism used in a `Promise.race` must be explicitly canceled when the race concludes. JavaScript does not automatically clear pending timers just because the promise they were associated with was dropped or rejected early.

**Prevention:**
1. Always assign `setTimeout` calls within `Promise.race` to a variable.
2. Use a `try/finally` block encompassing the `Promise.race` to call `clearTimeout` on that variable.
