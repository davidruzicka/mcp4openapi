## 2025-12-22 - Manual CORS Implementation Pitfalls
**Vulnerability:** Broken CORS configuration for allowed origins on non-preflight requests.
**Learning:** Manual CORS implementation in Express middleware can be brittle if ordering is not carefully managed. Specifically, an early return for `localhost` checks bypassed the logic that sets `Access-Control-Allow-Origin` headers for other allowed origins.
**Prevention:** When implementing manual CORS logic, ensure the header-setting logic runs for *all* valid requests before any early exit conditions, or use a standard middleware like `cors` which handles these edge cases robustly.
