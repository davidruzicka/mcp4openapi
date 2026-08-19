# OAuth 2.1 / RFC conformance remediation plan

Tracking issue: AIPP-572
Scope: mcp4openapi OAuth stack (authorization server + resource server): `src/auth/**`,
`src/transport/http-transport.ts`, `src/transport/oauth-grant-router.ts`.

Findings come from a code-read RFC-conformance audit, not runtime reproduction. Each fix
lands as: failing test first, then fix, then `npm run typecheck` + full suite green, then a
CHANGELOG entry. OIDC identity verification (AIPP-432 / MR !38) is out of scope here.

RFCs: 6749, OAuth 2.1 draft, 7636 (PKCE), 8414 (AS metadata), 9728 (protected-resource
metadata), 7591 (DCR), 6750 (bearer), 8707 (resource indicators).

## What is already conformant (do not regress)

S256 = `base64url(sha256)` unpadded; `timingSafeEqual` with length guard; authorization code
single-use on success + 5 min TTL, bound to `client_id`; `state` echoed verbatim; AEAD
`pid`-binding envelopes block cross-profile replay; refresh envelope 30-day TTL + 60s skew;
`Cache-Control: no-store`; Basic + POST client auth with constant-time secret compare; RFC 8414
required fields + `code_challenge_methods_supported: ['S256']`; RFC 9728 protected-resource
metadata + `resource_metadata` on OAuth-flow 401; RFC 8707 `resource` accepted without erroring;
DoS-bounded DCR (max 1000 clients, tiered idle-only eviction).

## Blocking

1. PKCE effectively optional. `/oauth/authorize` does not require `code_challenge`; the token
   endpoint verifies PKCE only `if (codeData.params.codeChallenge)`, so a flow that never sent a
   challenge skips PKCE. Require `code_challenge` (+ `code_challenge_method=S256`) at authorize;
   require a verifier for every code. `http-transport.ts:2108`, `oauth-provider.ts:1058`.
2. Expired access token fails open at the resource server. On refresh failure the token is still
   used and forwarded; no per-request `exp` check and the access envelope `exp` is not checked at
   consumption. Return 401 `invalid_token` with a `WWW-Authenticate` challenge.
   `mcp-server.ts:958-965`, `http-transport.ts:4949-4977`, `token-envelope.ts:290-321`.
3. DCR does not require `redirect_uris` (RFC 7591 2): missing/empty returns 201 with an empty
   list for an `authorization_code` client. Reject with 400 `invalid_redirect_uri`.
   `http-transport.ts:2530-2542`.
4. DCR validation errors return HTTP 500 instead of 400 with `invalid_redirect_uri` /
   `invalid_client_metadata`; those error codes do not exist in the codebase. Map typed
   validation errors to the RFC 7591 3.2.2 error JSON. `http-transport.ts:2565-2583`.

## Important

- Token `redirect_uri` not compared to the value bound to the code (6749 4.1.3).
  `oauth-provider.ts:1025-1046`.
- Code replay does not revoke tokens already issued. `oauth-provider.ts:1038-1041`.
- Authorization-endpoint errors returned as direct 400 instead of a 302 with `error` + `state`
  to a validated redirect_uri (4.1.2.1). `http-transport.ts:2075-2098`.
- Authorization code and `state` logged at info level. `oauth-provider.ts:982-985`.
- Host-only redirect_uri matching for the shared client; 4.1.3 requires exact match.
  `oauth-provider.ts:198,514-545`.
- Refresh tokens not rotated for the public shared client (OAuth 2.1 4.3.1).
  `refresh-envelope.ts:61`.
- `initializationPromise` never reset on rejection: one config-time failure permanently 500s all
  OAuth endpoints until restart. `oauth-provider.ts:237-284`.
- `invalid_client` via HTTP Basic returns 400 without `WWW-Authenticate` (5.2).
  `http-transport.ts:2160-2167`.
- `WWW-Authenticate` absent on the expired-session 401 (verified at `http-transport.ts:3457`) and
  on AuthenticationError paths.
- `/.well-known/openid-configuration` served without OIDC-required fields; drop the alias or serve
  a valid OP document. `http-transport.ts:1523-1526`.
- `issuer` may not equal the client-facing URL and can fall back to `http://` (8414 3.3).
  `http-transport.ts:1299-1314`.
- Token endpoint rejects unrecognized parameters; 6749 3.2 requires ignoring them.
  `oauth-grant-router.ts:30-35`.
- `code_challenge_method` not validated (plain/garbage accepted at authorize, always verified as
  S256). `oauth-provider.ts:828-836`.
- `code_verifier` present with no bound challenge is ignored and tokens issued.
  `oauth-provider.ts:1058`.
- DCR response omits `client_secret_expires_at` (7591 3.2.1). `http-transport.ts:2556-2564`.
- Weaker auth may shadow OAuth (static analysis, not runtime-verified): a garbage `X-API-Token`
  can create an unvalidated session on a non-consent OAuth profile; consent-gated profiles stay
  blocked at the gate. `http-transport.ts:3167,3240-3255`.
- Session-id acts as a bearer equivalent (no per-request token re-verification).
  `http-transport.ts:3069-3074`.
- Mid-session token swap without re-running validation. `http-transport.ts:3105-3116`.

## Moderate / nit

Failed PKCE does not consume the code (bounded by the 10 req/min limiter); bare `catch` collapses
all token failures into `400 invalid_grant` (including 5xx upstream and malformed requests);
`Bearer` scheme matched case-sensitively; no `code_verifier` length/charset validation
(43-128); upstream leg runs no PKCE; `token_endpoint_auth_methods_supported` missing from AS
metadata; DCR ignores `token_endpoint_auth_method: none` and always mints a secret; redirect_uri
scheme not validated at registration; `scope` advertised but never enforced and no
`insufficient_scope`/403; `token_type` not defaulted to `Bearer`.

## Test gaps

The `PROVES ISSUE` tests are conditional no-ops that can never fail. No tests cover: missing
challenge at authorize, `plain`/invalid method, verifier-without-challenge downgrade, token
`redirect_uri` binding, replay token revocation, fail-open expiry, OAuth + `X-API-Token`
shadowing, `issuer` == metadata URL, DCR error formats. `multi-auth.test.ts` asserts tautologies.

## Sequencing

1. Blocking 1 + 2 (security-impacting).
2. Blocking 3 + 4 (DCR client conformance).
3. Important batch, then moderate/nit.
