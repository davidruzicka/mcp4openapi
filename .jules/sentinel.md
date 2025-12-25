# Sentinel Journal

## 2025-05-23 - Localhost Origin Validation Bypass
**Vulnerability:** The HTTP transport middleware explicitly skips Origin header validation when the request target is `localhost` or `127.0.0.1`.
**Learning:** Developers often assume `localhost` is safe or want to avoid CORS issues during local development, but this allows any website (e.g., via a victim's browser) to make cross-origin requests to the local server (CSRF/interaction), bypassing security controls.
**Prevention:** Always validate the `Origin` header if present, even for localhost requests. Allowlists should include `localhost` explicitly rather than skipping the check entirely based on the `Host` header.
