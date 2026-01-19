---
name: auth-oauth
description: Implement or adjust authentication, OAuth flow, and multi-auth behavior. Use when editing auth interceptors, OAuth provider logic, or auth configuration.
---

# Auth and OAuth

## When to use
- Adding or updating auth configuration
- Modifying OAuth flows or session handling
- Adjusting multi-auth priority or behavior

## Steps
1. Update auth types in `src/types/profile.ts` as needed.
2. Modify auth logic in `src/interceptors.ts`.
3. Update OAuth flow in `src/oauth-provider.ts` if required.
4. Update `docs/OAUTH.md` and `docs/MULTI-AUTH.md` when behavior changes.
5. Update tests in `src/interceptors.test.ts` and `src/oauth-provider.test.ts`.
## Checks and tests
- Run `npm run typecheck` before finishing.
- Run `npm test`.

## Notes
- Always sanitize tokens in logs and errors.
- OAuth sessions have extended timeout compared to static token sessions.
