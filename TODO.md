# TODO

**Note**: This contains future work (P1/P2/P3).

---

## Contents

- [P1: Important](#p1-important)
  - [1. Add a transactional multi-replica consent evidence backend](#1-add-a-transactional-multi-replica-consent-evidence-backend)
- [P3: Optional](#p3-optional)
  - [17. Eager SSRF validation for SasankaApiKeyStore at profile load](#17-eager-ssrf-validation-for-sasankaapikeystore-at-profile-load)
  - [18. Remove legacy SHA-256 token envelope KDF fallback](#18-remove-legacy-sha-256-token-envelope-kdf-fallback)
- [P2: Nice-to-Have](#p2-nice-to-have)
  - [19. Gateway-mediated download proxy for upstream binary content](#19-gateway-mediated-download-proxy-for-upstream-binary-content)
  - [2. Export Profile Command](#2-export-profile-command)
  - [3. OpenAPI Operation Filter for Default Profile](#3-openapi-operation-filter-for-default-profile)
  - [4. Harden query parameter redaction canonicalization](#4-harden-query-parameter-redaction-canonicalization)
  - [7. Strengthen ReDoS Protection in Regex Compiler](#7-strengthen-redos-protection-in-regex-compiler)
  - [8. Limit HTTP profile server cache growth](#8-limit-http-profile-server-cache-growth)
  - [9. Break MCPServer-HttpTransport circular dependency](#9-break-mcpserver-httptransport-circular-dependency)
  - [10. Split HttpTransport into smaller modules](#10-split-httptransport-into-smaller-modules)
  - [11. Reduce usage of any casts in HTTP transport](#11-reduce-usage-of-any-casts-in-http-transport)
  - [12. Avoid HTTP profile hint collisions across shared IPs](#12-avoid-http-profile-hint-collisions-across-shared-ips)
  - [13. Prevent unbounded growth of HTTP profile hint cache](#13-prevent-unbounded-growth-of-http-profile-hint-cache)
  - [14. Consider strict OAuth redirect scheme allowlist](#14-consider-strict-oauth-redirect-scheme-allowlist)
  - [15. Replace JSON fingerprint auth comparison for tenant collisions](#15-replace-json-fingerprint-auth-comparison-for-tenant-collisions)
  - [16. Extract tenant session lifecycle from HttpTransport](#16-extract-tenant-session-lifecycle-from-httptransport)

## P1: Important

### 1. Add a transactional multi-replica consent evidence backend
**Goal**: Replace the single-node append-only file backend with a transactional store shared by all HTTP replicas. The current `FileConsentEvidenceStore` is durable and reloads external writes, but concurrent grants across multiple writers are not transactionally deduplicated.

**Implementation**:
- Add a database/managed-store implementation behind `ConsentEvidenceStore` with a unique key on subject + canonical issuer + tenant + profile + rules version, and persist revocation records alongside grants.
- Preserve the original `granted_at` on idempotent replays and expose storage failures as fail-closed typed errors.
- Keep policy out of the backend: TTL, revocation, rules pinning and rules-version rollback are evaluated in `ConsentGate`, so a backend only implements `record`, `revoke` and `lookup`. Reuse `src/testing/consent-store-contract.ts` as the conformance suite.
- Add concurrency, restart, partial-outage, and multi-replica tests.

## P2: Nice-to-Have

### 19. Gateway-mediated download proxy for upstream binary content

**Candidate, build only if large-file downloads become a real need.**

**Background**: `get-download-url` was removed from the Softeria SharePoint allow-list because it resolves a pre-authenticated Microsoft Graph URL that streams bytes with no `Authorization` header, outside the consent gate, the tool policy and the audit trail. `download-bytes` is the mediated replacement, but it returns base64 through the agent context, and upstream itself recommends the URL for anything above a few kB.

**Goal**: Keep downloads mediated without paying the base64 cost, by having the gateway stream the bytes.

**Implementation sketch**:
- Intercept the upstream tool result and rewrite `downloadUrl` to a gateway endpoint. The rewrite must be mandatory: if the raw URL can ever reach the client, the mediation is decorative.
- Serve that endpoint from an authenticated, session-bound route that re-checks consent per request, enforces a short TTL and a single use, and streams rather than buffers.
- Fetch the Graph URL through the existing SSRF validator, with a size cap and a per-session concurrency or byte quota.
- Emit an audit record per download with the pseudonymized subject, matching the per-call audit logging used by the consent gate.
- Tests: raw URL never leaves the gateway, expired or reused handle rejected, consent revoked between resolve and fetch blocks the fetch, quota and size cap enforced.

**Decision needed first**: whether large-file downloads through this gateway are in scope at all, or whether `download-bytes` is sufficient (tracked in YouTrack under the AIPP-432 consent-gate work).

### 2. Export Profile Command

**Goal**: Allow exporting auto-generated profile to file/stdout instead of using it directly.

**Use cases**:
- Generate starter profile for manual customization
- Debug auto-generation logic
- Version control profile alongside OpenAPI spec
- Share profiles between team members

**Implementation**:
```bash
# Export to file
mcp4openapi export-profile \
  --openapi-spec-path=api.yaml \
  --mcp-profile-path=profile.json \
  --mcp-toolname-strategy=balanced \
  --mcp-toolname-max=45 \
  --mcp-toolname-min-parts=3 \
  --mcp-toolname-min-length=20

# Export to stdout (for piping)
mcp4openapi export-profile --openapi-spec-path=api.yaml
```

**Technical approach**:
- Reuse existing `ProfileLoader.createDefaultProfile()` - no duplication!
- Add CLI command parser (yargs or commander)
- Add `src/cli-export.ts` for export logic
- Support all naming strategies and options
- Format JSON with 2-space indent

**Files to modify**:
- `src/cli-export.ts` (new) - export command implementation
- `src/index.ts` - add command routing
- `package.json` - add bin command `mcp4openapi-export`
- `README.md` - document export command

**Estimated effort**: 1-2 hours (mostly CLI parsing and formatting)

**Note**: This command could include auto-detection of probe endpoints for token validation in future versions.

### 3. OpenAPI Operation Filter for Default Profile
**Current**: Without profile, all OpenAPI operations generate tools. Complex APIs may produce 100+ tools with parameter inflation warnings.

**Goal**: Allow filtering operations when auto-generating default profile.

**Implementation Options**:

**Option A: Whitelist (Simple, Recommended for Start)**
```bash
export DEFAULT_PROFILE_ALLOWED_OPERATIONS="getProject,listProjects,createIssue"
```

**Pros**: Simple, deterministic, easy to audit
**Cons**: Requires maintenance when API changes

**Option A2: Regex Whitelist (Flexible)**
```bash
export DEFAULT_PROFILE_OPERATIONS_REGEX="^(get|list|create)"
# Example: only read operations
export DEFAULT_PROFILE_OPERATIONS_REGEX="^(get|list|search)"
# Example: exclude delete operations
export DEFAULT_PROFILE_OPERATIONS_REGEX="^(?!delete)"
```

**Pros**: Flexible, covers operation classes, adapts to API changes
**Cons**: Risk of unintended matches, harder to audit

**Option B: Blacklist (Exclusion-based)**
```bash
export DEFAULT_PROFILE_EXCLUDE_OPERATIONS="deleteProject,deleteIssue"
export DEFAULT_PROFILE_EXCLUDE_TAGS="admin,deprecated"
```

**Pros**: Include most, exclude specific dangerous operations

### 4. Harden query parameter redaction canonicalization
**Current**: `redactQueryParam()` supports exact key matching and now covers dot-separated parameter names, but standard URL parsing and fallback/manual parsing do not explicitly share one canonicalization strategy for encoded query keys or equivalent key spellings.

**Goal**: Keep query-parameter redaction deterministic across parser paths and reduce the risk of log leakage when sensitive keys appear in percent-encoded or otherwise equivalent forms.

**Implementation**:
- Define one canonicalization strategy for query parameter keys before comparison.
- Align `new URL()` handling and manual fallback handling so both paths redact the same keys.
- Add explicit tests for percent-encoded query keys and parser-path consistency.
- Keep the implementation bounded and regex-safe; do not introduce heuristic fuzzy matching.

**Files to modify**:
- `src/validation/validation-utils.ts`
- `src/validation/validation-utils.test.ts`

**Estimated effort**: 1-2 hours
**Cons**: May miss new dangerous operations

**Option C: Tag-based Filter (Leverages OpenAPI Tags)**
```bash
export DEFAULT_PROFILE_INCLUDE_TAGS="projects,issues,merge_requests"
export DEFAULT_PROFILE_EXCLUDE_TAGS="admin,system"
```

**Pros**: Semantic filtering aligned with API design
**Cons**: Requires well-tagged OpenAPI spec

**Recommendation**: 
- **Production/Security-critical**: Use **Option A (whitelist)** for explicit control
- **Development/Exploration**: Use **Option A2 (regex)** for flexibility
- **Well-documented APIs**: Add **Option C (tag-based)** for semantic filtering
- **Combination**: Support all three simultaneously (whitelist + regex + tags) with precedence: whitelist → regex → tags

**Files to modify**:
- `src/profile-loader.ts` - filter operations in `createDefaultProfile()`
- `README.md` - document env variables

**Estimated effort**:
- Whitelist: 1 hour
- Regex: 1 hour
- Tag-based: 1-2 hours
- Total (all three): 3-4 hours

### 7. Strengthen ReDoS Protection in Regex Compiler
**Problem**: `RegexCompiler` accepts user input from HTTP headers (`X-Mcp4-Tools`) and environment variables. While `RegexValidator` provides partial protection (length limits, nested quantifiers, ambiguous alternation), it doesn't cover all ReDoS attack vectors. A malicious user could craft regex patterns that pass validation but still cause exponential backtracking.

**Current protection**:
- Max length: 100 characters (configurable)
- Nested quantifiers detection: `(a+)+`, `(x*)*`, etc.
- Ambiguous alternation detection: `(a|aa)+`, `(foo|foobar)*`, etc.

**Gaps**:
- Other ReDoS patterns may pass validation
- No timeout for regex matching operations
- No limit on input length being tested against regex

**Goal**: Strengthen ReDoS protection to prevent DoS attacks via malicious regex patterns.

**Implementation options**:

**Option A: Add Regex Matching Timeout (Recommended)**
- Use worker threads or `piscina` to run regex matches with timeout
- Kill worker if match exceeds threshold (e.g., 100ms)
- Fallback to rejection if timeout occurs

**Option B: Expand Validation Patterns**
- Add detection for more ReDoS patterns (e.g., overlapping alternations, complex nested groups)
- Use regex analysis libraries (e.g., `safe-regex`, `redos-detector`)

**Option C: Limit Test Input Length**
- Restrict length of strings tested against compiled regex
- Tool names are naturally limited, but add explicit check in `CompiledRegex.test()`

**Recommendation**: Implement **Option A** (timeout) + **Option C** (input length limit) for defense in depth. Option B can be added incrementally.

**Files to modify**:
- `src/tool-filter/regex/regex-compiler.ts` - add timeout wrapper for regex matching
- `src/tool-filter/regex/regex-validator.ts` - expand pattern detection (optional)
- `src/tool-filter/regex/regex-compiler.test.ts` - add timeout and edge case tests

**Estimated effort**: 2-3 hours (timeout implementation) + 1-2 hours (expanded validation)

### 8. Limit HTTP profile server cache growth
**Problem**: HTTP profile routing keeps every requested profile's MCPServer initialized indefinitely. With many large OpenAPI specs, this can exhaust memory.

**Goal**: Add basic eviction or caps for profile server instances to bound memory usage.

**Implementation options**:
- TTL eviction: expire inactive profiles after `MCP4_PROFILE_CACHE_TTL_MS`.
- Max size: cap servers to `MCP4_PROFILE_CACHE_MAX` with LRU eviction.
- Combine TTL + max size with soft warnings when evicting.

**Files to modify**:
- `src/mcp-server-manager.ts` - eviction logic and tracking
- `src/index.ts` - pass env config into manager/registry
- `README.md` - document new env vars

**Estimated effort**: 2-4 hours

### 9. Break MCPServer-HttpTransport circular dependency
**Problem**: MCPServer holds a reference to HttpTransport (typed as any), creating a circular dependency and weaker type safety.

**Goal**: Remove direct dependency between MCPServer and HttpTransport for session cleanup and related hooks.

**Implementation options**:
- Introduce a small transport interface (methods used by MCPServer only) and type against that.
- Use event-based cleanup: MCPServer emits session cleanup events, HttpTransport subscribes.
- Invert control: move cleanup trigger into HttpTransport and pass a callback instead of full transport instance.

**Files to modify**:
- `src/mcp-server.ts` - replace direct transport reference with interface/callback
- `src/http-transport.ts` - adjust session cleanup hookup
- `src/mcp-server-manager.ts` - wiring changes if needed
- `README.md` or `IMPLEMENTATION.md` - document architecture change

**Estimated effort**: 2-3 hours

### 10. Split HttpTransport into smaller modules
**Problem**: `src/http-transport.ts` is >2700 lines. `setupRoutes` and related OAuth/MCP handlers are large and hard to maintain.

**Goal**: Improve maintainability by splitting HttpTransport into focused modules with clear responsibilities.

**Implementation options**:
- Extract OAuth handlers to `src/http/oauth-handler.ts` (authorize, token, callback, metadata).
- Extract MCP route setup to `src/http/mcp-router.ts` (POST/GET/DELETE + SSE).
- Keep core transport state in `src/http-transport.ts` and delegate route registration.

**Files to modify**:
- `src/http-transport.ts` - delegate to new modules
- new module files under `src/http/`
- `IMPLEMENTATION.md` - architecture update (if needed)

**Estimated effort**: 3-5 hours

### 11. Reduce usage of any casts in HTTP transport
**Problem**: `as any` casts have grown, especially in `src/http-transport.ts` and related unit tests, weakening type safety.

**Goal**: Replace `any` casts with explicit interfaces or type guards where practical.

**Implementation options**:
- Introduce small internal interfaces for private helper shapes used in tests.
- Add type guards for request/response mocks in unit tests.
- Replace `any` in `HttpTransport` signatures with typed callbacks or narrow types.

**Files to modify**:
- `src/http-transport.ts`
- `src/http-transport.unit.test.ts`
- `src/http-transport.test.ts`

**Estimated effort**: 2-4 hours

### 12. Avoid HTTP profile hint collisions across shared IPs
**Problem**: Profile hint keys are derived from IP and user-agent only, so different clients behind the same NAT with identical user agents can overwrite each other's hints. This can misroute profile resolution for OAuth endpoints or origin checks when profile routing has no default profile.

**Goal**: Make profile hint association more robust to shared IPs and identical user-agent strings.

**Implementation options**:
- Include additional request entropy in the key (e.g., TLS session ID, `X-Forwarded-For` chain hash, or a server-generated hint cookie).
- Set a hint cookie on first profile-routed request and use that as the primary key.
- Add a short-lived per-profile routing token embedded in OAuth metadata links.

**Files to modify**:
- `src/http-transport.ts` - profile hint keying and lookup logic
- `docs/HTTP-TRANSPORT.md` - document new hint mechanism (if user-facing)

**Estimated effort**: 2-4 hours

### 13. Prevent unbounded growth of HTTP profile hint cache
**Problem**: Profile hints are stored per client but only cleaned up on subsequent lookups, so many one-off clients can cause the cache to grow without bound in long-running servers.

**Goal**: Bound memory usage for profile hint cache.

**Implementation options**:
- Periodic cleanup timer that removes expired hints.
- Cap the cache size with LRU eviction.
- Combine TTL + size cap with logging when evictions occur.

**Files to modify**:
- `src/http-transport.ts` - add cache eviction or cleanup
- `README.md` - document any new env vars or limits

**Estimated effort**: 1-2 hours

### 14. Consider strict OAuth redirect scheme allowlist
**Current**: `ExternalOAuthProvider` uses a denylist for dangerous redirect URI schemes (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`) while keeping compatibility with custom client schemes.

**Goal**: Evaluate migrating to a strict allowlist-based scheme policy for stronger security guarantees.

**Implementation options**:
- Add `allowed_redirect_schemes` to OAuth profile config with secure defaults (`http`, `https`) and explicit custom scheme opt-in.
- Keep denylist as fallback behavior during migration to avoid breaking existing clients.
- Add compatibility tests for common deep-link clients and document migration guidance.

**Files to modify**:
- `src/types/profile.ts` - OAuth config type extension
- `src/auth/oauth-provider.ts` - scheme validation logic
- `src/auth/oauth-provider.test.ts` - allowlist and migration tests
- `docs/OAUTH.md` and `README.md` - configuration guidance

**Estimated effort**: 2-4 hours

### 15. Replace JSON fingerprint auth comparison for tenant collisions
**Current**: `authFingerprint` in `src/transport/http-tenant-config.ts` compares tenant auth compatibility via `JSON.stringify` over mapped auth config objects.

**Analysis**:
- Relevance is medium: current mapping to known keys reduces top-level key-order risks, so this is not an immediate correctness bug.
- Residual fragility remains for nested structures (for example `oauth_config`) and long-term readability/maintainability.
- A semantic comparator communicates intended equality rules better than string fingerprinting.

**Goal**: Replace serialization-based comparison with explicit deterministic auth config comparison.

**Implementation options**:
- Introduce dedicated utility (for example `areAuthConfigsEquivalent(left, right)`).
- Define explicit semantics for array order (sensitive vs insensitive) and document the choice.
- Perform field-level comparison for known auth interceptor properties, including nested `oauth_config`.
- Reuse comparator in tenant collision checks where `authFingerprint(...)` is currently used.
- Add focused tests for equivalent configs, non-equivalent configs, and nested OAuth config differences.

**Files to modify**:
- `src/transport/http-tenant-config.ts`
- `src/transport/http-tenant-config.test.ts`

**Estimated effort**: 1-2 hours

### 16. Extract tenant session lifecycle from HttpTransport
**Problem**: `HttpTransport` currently combines routing, auth, filtering, SSE/session control, and tenant-specific session state/lifecycle (`tenantOAuthProvidersBySessionId`, tenant selector consistency checks, tenant context hydration). This concentration increases coupling and regression risk.

**Goal**: Move tenant session responsibilities into a dedicated service while keeping transport behavior unchanged.

**Implementation options**:
- Introduce `TenantSessionService` (or `SessionManager` with tenant-focused submodule) to own:
  - tenant context selection/validation for initialize and non-initialize requests
  - session-level tenant OAuth provider map lifecycle (create/get/cleanup)
  - tenant header immutability checks and error mapping
- Keep `HttpTransport` as orchestrator only (HTTP parsing/routing + delegation).
- Add small interfaces for session store access to avoid introducing new circular dependencies.

**Files to modify**:
- `src/transport/http-transport.ts`
- `src/transport/http-tenant-config.ts` (reuse and tighten public API boundaries)
- `src/transport/http-transport.test.ts`
- optional new module(s): `src/transport/tenant-session-service.ts`

**Estimated effort**: 3-5 hours

---

## P3: Optional

### 17. Eager SSRF validation for SasankaApiKeyStore at profile load

**Background**: Phase 3 (`SasankaApiKeyStore`) defers full SSRF validation (private IP range checks via `SSRFValidator`) to the first `validate()` call at session init time. Only the `https:` protocol check is enforced at profile load. A misconfigured `base_url` pointing at a private address (e.g., `https://10.0.0.5/`) passes profile loading and only fails on the first real client session.

**Goal**: Fail at profile load rather than at first session. Move the `SSRFValidator.validate()` call into `ClientAuthGate` construction (or a dedicated `async init()` method called from `getProfileState()`).

**Benefits**:
- **Fail-fast**: misconfigured `base_url` is caught during server startup or profile reload, not under real user load.
- **Operator clarity**: the error surfaces in startup logs with a clear message, not buried in a session-init 401.
- **Consistent with `JwksCache`**: `JwksCache` validates SSRF on every JWKS refresh; eager validation for Sasanka aligns the two auth paths.
- **No runtime overhead**: SSRF check runs once at construction, not per session.

**Implementation approach**:
- Add `async init(): Promise<void>` to `ClientAuthGate` that calls `ssrfValidator.validate(base_url)` on the `SasankaApiKeyStore` if configured.
- In `getProfileState()` (http-transport.ts), call `await state.clientAuthGate.init()` after construction.

**Trade-off**: adds an async step to profile state initialization (first request for a profile, or server startup). Low overhead since it is a single DNS+TCP probe. The simpler current approach (lazy-with-flag) is acceptable for most deployments.

**Files to modify**:
- `src/auth/client-auth-gate.ts` - add `async init()` method
- `src/auth/sasanka-api-key-store.ts` - expose `validateSsrf(): Promise<void>`
- `src/transport/http-transport.ts::getProfileState()` - await `clientAuthGate.init()`

**Estimated effort**: 1-2 hours

### 18. Remove legacy SHA-256 token envelope KDF fallback

**Background**: The passphrase path of `deriveTokenKey()` was migrated from unsalted SHA-256 to scrypt (CWE-916, CodeQL js/insufficient-password-hash). To avoid breaking existing production sessions, `decryptTokenPayload()` accepts a `fallbackKey` derived via `deriveLegacySha256TokenKey()` (wired as `legacyTokenKey` from `MCP4_OAUTH_KEY` passphrases) so pre-migration `mcp4.v1.*` envelopes still decrypt. New envelopes are always scrypt-derived, so legacy envelopes age out naturally on token refresh/expiry (max envelope age 30 days).

**Goal**: Remove the SHA-256 fallback once all pre-migration envelopes have expired.

**When safe to remove**: at least 30 days (MAX_ENVELOPE_AGE_MS) after the scrypt migration ships in a release - any remaining legacy envelope is stale and rejected anyway.

**Files to modify**:
- `src/auth/token-envelope.ts` - remove `deriveLegacySha256TokenKey()` and the `fallbackKey` parameter from `decryptTokenPayload()`
- `src/transport/http-transport-config.ts` - remove `legacyTokenKey` derivation
- `src/types/http-transport.ts` - remove `legacyTokenKey` field
- `src/transport/http-transport.ts` - drop `legacyTokenKey` argument at both `decryptTokenPayload` call sites
- Tests: `src/auth/token-envelope.test.ts`, `src/transport/http-transport-config.test.ts`

**Estimated effort**: 30 minutes
