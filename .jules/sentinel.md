## 2026-01-07 - Conditional HSTS for Universal API Servers

**Vulnerability:**
Strict-Transport-Security (HSTS) was missing, which is a best practice for production but problematic for local development and ACME certificate challenges (Let's Encrypt).

**Learning:**
In a universal API server designed to run both locally (via `localhost`) and in production (potentially behind proxies), HSTS must be conditional. Applying it blindly breaks local development (forcing HTTPS on localhost) and can interfere with HTTP-01 challenges for certificate renewal.

**Prevention:**
Implement logic to skip HSTS for:
1. `localhost` and `127.0.0.1` (Local development)
2. Raw IP addresses (Direct access, often internal)
3. `/.well-known/acme-challenge/` paths (Certificate renewal)

This logic should be centralized in the HTTP transport middleware.
