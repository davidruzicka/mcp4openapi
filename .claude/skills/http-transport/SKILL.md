---
name: http-transport
description: Work on HTTP transport, sessions, and interceptors. Use when modifying HTTP transport behavior, rate limits, retries, or session handling.
---

# HTTP transport

## When to use
- Changing HTTP transport behavior
- Adjusting rate-limit, retry, or fetch logic
- Modifying session handling or request pipeline

## Steps
1. Update `src/http-transport.ts` for transport behavior.
2. Update `src/http-client-factory.ts` for session and client logic.
3. Follow the interceptor order: auth - rate-limit - retry - fetch.
4. Update `docs/HTTP-TRANSPORT.md` if behavior changes.
5. Update relevant tests in `src/http-transport*.test.ts`.
## Checks and tests
- Run `npm run typecheck` before finishing.
- Run `npm test`.

## Notes
- Keep error handling typed and include correlation ids.
- Do not add HSTS headers.
