## 2025-12-23 - Missing Security Headers
**Vulnerability:** The Express application was missing standard security headers (HSTS, CSP, X-Frame-Options, etc.), increasing risk of XSS, clickjacking, and MIME-sniffing.
**Learning:** Even with manual CORS handling, standard security headers are often overlooked in custom server implementations.
**Prevention:** Implemented a reusable `securityHeaders` middleware in `src/security-headers.ts` that enforces these headers on all responses.
