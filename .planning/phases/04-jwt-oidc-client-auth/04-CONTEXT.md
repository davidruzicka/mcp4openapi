# Phase 4 Context: Client Authentication Gate — JWT/OIDC

## Why this phase exists

JWT/OIDC identity verification was originally part of Phase 3 but deprioritized in favor of faster API key delivery. The prerequisite infrastructure (JwksCache, ClientAuthJwtConfig types, profile validator for jwt block) was built in Phase 3 plans 01–03 and is ready to use.

## What Phase 3 left ready for this phase

- `src/auth/jwks-cache.ts` — JWKS key caching with per-issuer TTL and size limits
- `src/types/profile.ts` — `ClientAuthJwtConfig` interface (issuer, jwks_uri, trust_mode, audience, allowed_algs, clock_skew_seconds)
- `src/profile/client-auth-gate-validator.ts` — validates jwt block at profile load time
- `src/auth/client-auth-gate.ts` — ClientAuthGate constructor accepts config.jwt (currently ignored)
- `src/core/errors.ts` — ClientAuthGateError

## Planned scope

- `oidc-discovery.ts` utility: resolveOidcJwksUri() with 64 KB size limit, issuer mismatch check, JWKS hijacking prevention
- Refactor EnterpriseAuthProvider._resolveJwksUri() to delegate to the shared utility
- Add JWT path to ClientAuthGate.validate(): decodeProtectedHeader → JwksCache.getResolver → jwtVerify
- Security boundary: JWT-shaped tokens that fail validation MUST NOT fall through to API key path
- Wire shared JwksCache instance from HttpTransport into ClientAuthGate constructor

## Prior art

See `.planning/phases/03-client-authentication-gate/03-PRIOR-ART.md` for microsoft/mcp-gateway JWT middleware patterns.
