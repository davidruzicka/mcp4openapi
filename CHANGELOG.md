# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Security
- Consent gate hardening: enforcement at a single upstream dispatch chokepoint in every transport mode (`tools/list` gated like `tools/call`, single-profile HTTP and multi-profile routing alike, fail-closed without a reachable enforcer, consent-gated profiles refuse to start on stdio, denials counted as a dedicated `ConsentRequired` metric, upstream-only profiles required), consent satisfied only by a verified profile-OAuth OIDC identity (OIDC Core `azp` multi-audience validation, canonical issuer at lookup, no `client_id` subject fallback), grants pinned via `rules_hash` with operator revocation, optional `consent_gate.max_age_days` and a rules-version rollback guard, encrypted identity-bearing `mcp4.r1.*` refresh envelopes, browser-bound approval (`__Host-` cookie plus fingerprint-keyed pending approvals), 0700/0600 size-capped evidence files read incrementally, and hard startup failure without `MCP4_CONSENT_EVIDENCE_PATH`/`MCP4_OAUTH_KEY`.
- Softeria SharePoint boundary hardening: environment upstream overrides are always validated and cannot broaden tool policy or downgrade sanitization policies, the effective upstream endpoint is logged with an off-origin warning, the read-only allow-list is pinned to the exact v0.136.0 catalog, `get-download-url` is removed because its pre-authenticated Graph URL bypasses the gateway (use `download-bytes`), and logs/audit records use SHA-256 pseudonyms for OIDC subjects.
- Token envelope passphrase KDF switched from unsalted SHA-256 to scrypt (CWE-916); existing SHA-256-derived envelopes still decrypt via a legacy fallback key and age out naturally on token refresh (fallback removal tracked in TODO.md, item 18). 64-char hex keys unaffected.
- Upstream tool sanitizer `strip` HTML policy now repeats tag removal until stable so nested payloads cannot reassemble a tag (CWE-116).
- Dependency upgrades resolving all `npm audit` findings: hono 4.12.34, @hono/node-server 2.0.11 (requires Node >=20), express-rate-limit 8.6.2 with ip-address 10.5.0, fast-uri 3.1.5, brace-expansion 5.0.9, nanoid 3.3.18, and postcss 8.5.26.

### Changed
- Consent evidence format changed (JSONL records carry a `type` discriminator and `rules_hash`, also covering the earlier issuer/tenant binding change): existing evidence files are ignored and every subject must re-grant consent once, and a denial now invalidates the session once per subject and rules version so clients re-run OAuth; the Softeria SharePoint profile moved to the internal deployment repository, kept here only as a test fixture (`tests/profiles/softeria-sharepoint/`) with catalog validation via `tools/list` against the running upstream instead of `--list-permissions`.
- OAuth authorization now applies profile-configured scopes over client-requested scopes, guaranteeing the `openid` scope on consent-gated profiles.
- `normalizePath` now returns `other` for unrecognized HTTP paths instead of the raw path, preventing unbounded Prometheus label cardinality from dynamic route segments.
- MCP `initialize` responses now expose `serverInfo.title` from the active profile `profile_name` (optionally suffixed via `MCP4_SERVERINFO_SUFFIX`) so VS Code and similar clients show per-profile names without changing `serverInfo.name`.
- Implementor pipeline now attempts IMPLEMENTOR_FALLBACK_COMMAND on process-level backend failures; @openai/codex moved to devDependencies for cached installs; Codex OAuth auth supported via CODEX_AUTH_JSON with automatic token refresh persistence.
- Refined the autonomous-agent workflow to the final issue/PR label taxonomy, added shared state-machine helpers for issuer/planner/implementor/reviewer transitions, made reviewer/merger automation tolerate legacy review labels during on-touch migration and reconciliation, taught issuer/planner stronger semantic duplicate triage with a pluggable bounded backend contract, and preserved exact open-title duplicate detection as the minimum fallback guard.
- Bumped transitive security-sensitive dependencies via overrides (`@hono/node-server` to `1.19.10`, `hono` to `4.12.4`) and aligned Semgrep SBOM negative test inputs/expectations with current `deploymentSlug`/`deployment_id` validation behavior.
- Updated `express-rate-limit` to `^8.3.1` to remediate the open GitHub Security / Dependabot alert for IPv4-mapped IPv6 rate-limit keying.

### Added
- Consent page customization per deployment: `consent_gate.template_path` supplies a full-page HTML template (mandatory `{{consent_body}}` placeholder for the server-owned form/info/expired block; cosmetic placeholders `{{rules_version}}`/`{{rules_summary}}`/`{{education_resource}}`/`{{title}}`) and `consent_gate.labels` overrides the accept/submit texts. Labels are part of the rules hash (changing them forces re-consent); the template is cosmetic and deliberately not hashed. Form mechanics, CSP and no-store headers stay server-owned; scripts remain blocked. Pending-approval bounds are tunable via `MCP4_CONSENT_APPROVAL_TTL_MS` and `MCP4_CONSENT_PENDING_MAX` (AIPP-522).
- PostgreSQL consent evidence store (`MCP_CONSENTS_DB_HOST/PORT/NAME/USER/PASSWORD`, TLS on by default with `MCP_CONSENTS_DB_SSL=false` opt-out for local dev): transactional multi-replica backend behind the same `ConsentEvidenceStore` contract, append-only audit table created on first use, preferred over the JSONL file when configured; a partial variable set fails startup instead of silently falling back (AIPP-519).
- Consent gate (`consent_gate` profile block) gates sensitive profiles behind provable human consent: interactive OAuth login with a mandatory approval step, OIDC identity verification, dispatch-time enforcement (JSON-RPC `-32004` when missing), and consent bound to the verified subject + `rules_version`. Evidence is pluggable - in-memory for dev, durable append-only JSONL via `MCP4_CONSENT_EVIDENCE_PATH` (`FileConsentEvidenceStore`) for single-node/staging, or the PostgreSQL store above for multi-replica production (AIPP-432).
- Profile index redirects: `MCP4_HTTP_PROFILE_INDEX_REDIRECT_URL` redirects browser-facing `GET /` requests with configurable `301` or `302` status while JSON profile discovery remains available through `Accept: application/json`.
- `MCP4_SYSTEM_NOTICE` env var adds a full-width banner at the top of the HTML profile index with configurable severity (`info` / `warning` / `error`) and matching color scheme; plain string defaults to `info`, JSON `{"message":"...","severity":"warning"}` sets severity explicitly.
- Profile index page (`/`) syncs selected profile to URL hash (e.g. `/#scif`), enabling direct shareable links; hash is read on load so navigating to `/#<profileId>` pre-selects that profile.
- YouTrack profile: `retrieve_content:list_issue_link_types` to look up available link type IDs; `create_content:add_issue_link` now accepts `body:{id}` (internal DB id) and `issueLinkId` with direction suffix (`<typeId>s`/`<typeId>t`), matching the actual YouTrack REST API contract; executor supports explicit `body` param override for single-object reference endpoints.
- Expanded n8n profiles and OpenAPI spec to full Public API coverage (n8n@2.21.7): credentials list/get/test, execution stop/stop_all/tags, workflow archive/unarchive, data tables (CRUD + rows + columns), project folders, community packages, and instance insights; 76 operations across 13 tools (profile.json) and 53 operations across 5 tools (profile-optimized.json).
- DefectDojo profile (`profiles/defectdojo/`) with 6 CRUD-style tools covering findings, products, engagements, tests, endpoints, scan import/reimport, and admin resources; uses new `token` auth type - set `DEFECTDOJO_TOKEN=<api-key>` (raw key, server adds `Token ` prefix); fixed `isMultipartOperation` to require binary fields so DRF alternative-encoding multipart does not trigger file-upload path.
- New `token` auth type (profile `interceptors.auth.type: "token"`) for DRF/Django REST Framework Token auth - sends `Authorization: Token <key>`; inbound MCP clients likewise send `Authorization: Token <key>`.
- GitLab profiles: added project wiki page CRUD support to both the optimized CRUD profile and the developer-oriented profile, including bundled OpenAPI entries and focused test coverage.
- GitLab profiles: added project wiki attachment upload and wiki note CRUD support to both the optimized CRUD profile and the developer-oriented profile, including multipart runtime support, bundled OpenAPI entries, and focused test coverage.
- Per-tool-call audit log (`audit:tool_call` at INFO) and per-upstream Prometheus dimension: `mcp_tool_calls_total`, `mcp_tool_call_duration_seconds`, and `mcp_tool_call_errors_total` gain `upstream_host` label (capped at 128 chars); client identity captured in audit log only as `clientPrincipal` (excluded from Prometheus to avoid unbounded per-user cardinality); both HTTP and stdio paths emit structured audit records with `sessionId`, `clientPrincipal`, `tool`, `upstreamHost`, `outcome`, and `durationMs` on success, error, and all upstream early-rejects.
- `MCP4_HIDDEN_PROFILES`: comma-separated profile ids/names/aliases to hide from the HTML index page while keeping profiles fully functional (MCP connection, allowlist, direct URL).
- Encrypted token envelopes (`mcp4.v1.*`, AES-256-GCM, profile_id as AAD) for restart-resilient OAuth: when `MCP4_OAUTH_KEY` is set, OAuth clients survive k8s pod restarts without re-authentication; backward-compatible (unset = plain-token mode + startup warn).
- GitLab profiles: added `get_job_log` action (`GET /projects/:id/jobs/:job_id/trace`) to `retrieve_content` and `manage_pipelines_jobs` tools, including OpenAPI spec entry and test coverage.
- Client auth gate types (`ClientAuthGateConfig`, `ApiKeyStoreConfig`, `InlineApiKeyEntry`), `ClientAuthGateError`, `SessionData.clientPrincipal` field, and profile-load-time validator (`validateClientAuthGateProfile`) for AUTH-02/AUTH-03. Phase 3 ships inline API keys only; JWT/OIDC types and the `sasanka` API key backend are added in Phase 4.
- `ApiKeyStore` interface with `InlineApiKeyStore` (constant-time HMAC-SHA256 comparison via `timingSafeEqual` on equal-length 32-byte digests, erasing length as a timing side-channel) and extensible `createApiKeyStore` factory for AUTH-02 M2M API key validation. `SasankaApiKeyStore` is added in Phase 4.
- `ClientAuthGate` orchestrator wired into HTTP transport session init: validates inbound client API key before session establishment; resolves `AuthorizedPrincipal` (authType=`token`) and attaches it as `session.clientPrincipal`; mode-aware (`required` rejects with HTTP 401 when no identity is resolved, `optional` allows anonymous sessions); when configured, the gate becomes the inbound auth authority and bypasses the legacy `authConfigs` token-required guard so `mode='optional'` can permit anonymous initialization (AUTH-02; partial AUTH-03). JWT/OIDC gate added in Phase 4.
- Upstream MCP proxy: tools/list and tools/call forwarding with tool name/description sanitization, tools/list_changed notification relay with bounded queue buffering and replay on SSE reconnect.
- Upstream tool sanitizer drops tools from upstream MCP servers with invalid names (outside `[a-zA-Z0-9_-]`, over 255 chars) or forbidden description characters (`<`, `>`, backtick, over 2048 chars); dropped names are truncated to 100 chars + ellipsis (103 chars max) to prevent log injection.
- Bounded notification queue buffers upstream MCP notifications with configurable size cap (default 50) and TTL (default 5 min) using wall-clock eviction; drains in insertion order.
- Profile validation now rejects profiles that define both `upstream_mcp` and non-empty `tools[]` with a clear "mutually exclusive" error at load time.
- Upstream MCP session foundation: lazy connection manager, per-session credential store with downstream token passthrough and `value_from_env` fallback, heartbeat health monitoring, typed upstream errors with correlation IDs, and session-scoped connection cleanup.
- Upstream credential validation at session init: optional `validation_endpoint`/`validation_method`/`validation_timeout_ms` fields on `UpstreamMcpServerConfig` enable SSRF-protected early auth checks so invalid tokens surface immediately at session initialization rather than on first tool call.
- Bearer token redaction in error messages now preserves last 4 chars as diagnostic suffix (e.g. `Bearer [REDACTED]...xQ5g`) to help identify which token failed without exposing it.
- Added repository-scoped autonomous-agent docs plus tested proposal-intake/issuer/planner/implementor/reviewer/merger automation helpers, bounded duplicate-candidate ranking/runtime scripts, a default Codex-backed implementor wrapper with machine-readable handoff output, implementor command disclosure reconciliation, and GitHub Actions workflows for the full multi-agent issue-to-PR pipeline.
- Added signed planner-artifact trust primitives plus env-driven verification config so planner review-follow-up handoff can be verified on implementor execution paths while lenient planner dedupe still reads legacy artifacts.
- Added shared review-follow-up/planner-artifact automation primitives for per-head review-thread state, machine-readable fix/test handoff, and implementor in-thread follow-up replies.
- Added profile-driven MCP Apps support with `resources/list`, `resources/templates/list`, `resources/read`, template completion, stricter Apps mapping/path validation, session-aware fetch execution, and bounded fetch-result caching.
- Expanded the GitHub security profile with Secret Scanning CRUD actions, stricter action-gated parameter validation (`allowed_for`/`forbidden_for`), and an upgraded `retrieve_security_overview` composite across code scanning + Dependabot + secret scanning.
- Added enterprise managed authorization for HTTP transport with profile-driven `enterprise_authorization`, JWT bearer grant support on `/oauth/token`, bounded JWKS/replay/token stores, metadata extensions, and security-focused validation/redaction coverage.
- Added env-backed `enterprise_authorization` field resolution for issuer, audience, mode, selected access-policy settings, and claim mappings so deployments can override enterprise auth without editing profiles.
- Added phase 1 support for approved unregistered OAuth clients so authorize requests can materialize local clients when `redirect_uri` matches an explicit allowlist, improving multi-pod OAuth compatibility without weakening redirect validation.

### Fixed
- Consent gate review fixes (round 2, security): identity-bearing refresh envelopes older than the 30-day identity TTL or future-dated are rejected instead of rebinding the subject indefinitely; OIDC discovery and JWKS fetches refuse HTTP redirects so SSRF validation and the same-origin JWKS pin apply to the URL actually fetched; plain refresh-token identity bindings are bound to the issuing OAuth client (a different client no longer inherits the identity); consent-gated OAuth `issuer`, `redirect_uri` and `education_resource` must be valid `https://` URLs at profile load (literal or env-resolved); malformed or unparseable consent evidence lines fail closed instead of silently skipping revocations; revocation appends are exempt from the evidence-file size cap (with a per-line bound) so a full file cannot block a revoke; the unkeyed observability-pseudonym fallback logs a one-time warning.
- Consent gate review fixes (round 2, correctness): the grant-fold decision is one shared predicate across the in-memory, JSONL and PostgreSQL stores, so an equal-timestamp re-acceptance of an older `rules_version` no longer diverges on PostgreSQL; PostgreSQL orders revocation supersession by insertion order instead of caller-supplied timestamps (clock-skew safe); JSONL lookups are serialized with writes (no transient false denials under concurrent record+lookup); envelope restart-recovery normalizes the issuer before comparing (a trailing-slash configured issuer no longer forces a re-auth loop after every restart); setting only `MCP_CONSENTS_DB_SSL` from the `MCP_CONSENTS_DB_*` family now fails startup instead of silently dropping the PostgreSQL backend; the redundant `grantRenewedAt` field was removed from the store contract; the Softeria upstream catalog fixture is pinned to a single `upstream_pin` source of truth with a regeneration script (`scripts/capture-softeria-catalog.sh`); shared `${env:VAR}` resolution replaces three divergent copies (validator, OAuth provider, HTTP transport).
- Consent gate review fixes: consent renewals and rules-version re-acceptances are now persisted to the evidence file (re-consent survives gateway restarts and the audit trail is complete), refresh envelopes are bound to the issuing OAuth client, `max_age_days` is validated (rejecting `0`/negative values that silently disabled expiry), ID tokens must carry `exp`/`iat`, a failed OIDC discovery no longer blocks all later logins, and OAuth redirect logs no longer contain state/nonce values.
- Consent gate: restart-recovered encrypted OAuth envelopes retain verified OIDC identity so consent-gated reconnects remain valid, and file-backed consent evidence writes recover after an individual write failure and clear stale index state when the evidence file disappears.
- GitLab GLQL guidance now steers callers toward YAML payloads, verified field names, and unquoted enum filters in both profiles and the bundled OpenAPI spec.
- Grafana profile now routes datasource metadata/resources, correlations, snapshot sharing settings, and other admin-like reads through `retrieve_admin_content`; `query_metrics` now requires Grafana-style `from`/`to` + `queries`, and user lookup now sends the required `loginOrEmail` query parameter.
- `handleOtherRequest` upstream `tools/list` pre-flight error now uses `mapUpstreamErrorToMcpError` (provider-safe message) instead of generic "Internal error"; `req.method` truncated to 200 chars in error logs; `uri` and prompt `name` params capped at 2048/256 chars with `-32602` validation errors.
- `MCP4_ALLOW_UNREGISTERED_CLIENTS`, `MCP4_ALLOWED_UNREGISTERED_REDIRECT_URIS`, and `MCP4_ALLOWED_ORIGINS` env vars now act as operator overrides: when set, they take full precedence over profile JSON values (previously `??` meant `allow_unregistered_clients: false` in profile silently blocked the env var).
- Encrypted token envelope restart-recovery: `inboundAuthTokenStore` now populated after session creation (fixes enterprise enforcement on restored sessions); stale envelopes (>30 days) now return HTTP 401 instead of silently creating a scopeless session; map population moved post-`createSession` to prevent map leaks on init failure; entry guard changed from `!refreshToken` to `!tokenData` to correctly skip recovery when OAuth map already populated for non-rotating IdPs.
- Invalid supplied tokens during HTTP session initialization now return HTTP 403 instead of 401, preventing VS Code from misclassifying bearer-token failures as OAuth discovery and showing an irrelevant dynamic client registration prompt.
- Tenant OAuth degradation: auth gate now checks `isOAuthConfigOperational` on the effective OAuth config (which may be tenant-specific) so an inoperational tenant OAuth config no longer sends an uncompletable 401 OAuth challenge.
- Server-side env token validation at session init: when a profile auth config has both `value_from_env` and `validation_endpoint`, the resolved env token is validated via the endpoint before the session is established, failing fast with HTTP 401 instead of accepting the connection and returning 401 on every tool call.
- `upstream_mcp.timeout_ms` is now enforced on proxied `tools/call`: passed as `RequestOptions.timeout` to `client.callTool()` so a hung upstream is bounded by the configured value instead of the SDK default.
- `MCPServerManager` self-registers the `onSessionDestroyed` cleanup hook in its constructor, eliminating the unbounded `sanitizedAndPolicyFilteredToolNames` map growth when the manager is used outside the `index.ts` bootstrap path.
- `UpstreamAuthError` now maps to `ErrorCode.InvalidRequest` (-32600) instead of `InternalError`; `AuthenticationError` and OAuth-required responses also use `InvalidRequest` instead of `-32001` (`RequestTimeout`), eliminating the code collision that caused clients to trigger auth flows on upstream timeouts.
- `X-Mcp4-Tools` session filter now correctly applies to upstream proxy profiles: exact-name and regex rules are evaluated as inline predicates at `tools/list` and `tools/call` time; `_allow_list`/`_allow_read` category rules are rejected at session init with an actionable error (OpenAPI metadata unavailable for upstream tools).
- Broken TOC anchor in `TODO.md` for item 17 (`sasakaapiKeyStore` corrected to `sasankaapikeystore`).
- `getOrConnect` now closes the stale client and transport when replacing a FAILED connection, preventing late `onerror`/`onclose` events from firing against the replacement and releasing accumulated leaked sockets (P1).
- `schemaContainsForbiddenChars` now returns `true` when recursion depth exceeds 10, treating over-limit schemas as potentially malicious instead of silently passing them - closes the bypass where forbidden chars beyond depth 10 were invisible to the sanitizer (P2).
- `createConnection` validates `transport.url` via `SSRFValidator` before any network call (SSRF guard); `inputSchema` recursively scanned for forbidden chars (`<`, `>`, backtick); `null` tools field from `listTools` now throws `UpstreamMalformedResponseError`; notification handler errors logged instead of unhandled rejections; `destroyedSessions` pruned after 60s TTL; `NOTIFICATION_DISPATCH` schema type broadened to `$ZodType` for extensibility.
- `getOrConnect` now stops the heartbeat timer before replacing a connection on token rotation or FAILED recovery, preventing stale timer from marking the new connection FAILED; token mismatch during in-flight connect now waits for the pending to settle and opens a fresh connection instead of reusing stale credentials.
- REL-01: `UpstreamHeartbeatManager` is now wired into `UpstreamConnectionManager`
- `UpstreamConnectionState` narrowed to `'CONNECTED' | 'FAILED'`; unused `IDLE`/`CONNECTING`/`RECONNECTING` states removed to eliminate misleading contract.
- `UPSTREAM_ERROR_MAPPINGS` moved to module scope in `mcp-server.ts`; was re-allocated on every `tools/call` invocation.
- `mapConnectError` now uses an explicit `hasMcpStatusCode` type guard instead of an unsafe cast, making the SDK status code assumption unit-testable and SDK-upgrade-safe.
- `destroyedSessions` marker is now retained after `closeAll()`
- `tools/list` now emits a `WARN` log when enterprise policy silently blocks all upstream tools (all require `'modify'` permission with no OpenAPI metadata to infer category).
- `validateCredentials` now accepts `sessionId: string | undefined`; pre-session calls log `phase: 'pre-session-init'` instead of the sentinel string `'pre-session'` that polluted log traces, preventing a race window where a reconnect attempt could create an orphaned upstream connection for a session being torn down.
- `UpstreamConnectionManager` is now statically imported in `mcp-server.ts`; the dynamic import comment claiming a circular dep risk was unverified (confirmed no cycle via madge); heartbeat pings start on each successful upstream connection and stop on `closeAll`, detecting silent SSE disconnects before tool calls fail.
- `getUpstreamToken` now uses the downstream client token first and falls back to `upstream_mcp.auth.value_from_env` when the client sends no token; previously env-configured providers always used the env token, ignoring the client-forwarded credential.
- `tools/list` and `tools/call` in upstream proxy mode now enforce `upstream_mcp.tools.allow`/`deny` lists; previously the profile-level tool policy was validated at load time but never applied at runtime.
- `tools/list` now emits a `WARN` log when `upstream_mcp.tool_prefix` is configured, as prefixing is accepted by the schema but not yet applied at runtime.
- `getUpstreamMcpConfig` now falls back to `profile.upstream_mcp` when `HttpTransport` profile context does not carry it (single-profile HTTP startup); previously upstream routing was silently bypassed.
- `getOrConnect` now detects token rotation: a changed `token` argument closes the old upstream connection and opens a new one with the fresh credential.
- `closeAll` marks the session as destroyed before awaiting in-flight connections so any `createConnection` resolving after teardown self-closes immediately, preventing orphaned upstream resources.
- `handleToolCall` now enforces `X-Mcp4-Tools` filter and enterprise authorization policy before forwarding to upstream, matching the gates applied to local tools.
- `tools/call` to upstream now validates the tool name against the sanitizer policy (`[a-zA-Z0-9_-]`, max 255 chars) before forwarding, preventing invocation of tools dropped from the sanitized list.
- `UpstreamConnectionManager` now ships with real production `clientFactory`/`transportFactory` defaults (MCP SDK `Client` + `StreamableHTTPClientTransport`); previously both defaults threw, making all upstream proxy calls fail at runtime.
- `upstream_mcp` proxy is now wired at HTTP startup in both single-profile and profile-routing modes; previously `getUpstreamClientFn` was never set, causing upstream tools to be silently unavailable.
- `drain()` on `NotificationQueue` now re-applies TTL eviction before returning entries, preventing stale notifications from being replayed on reconnect after extended disconnection.
- `upstream_mcp.validation_endpoint` is now checked during session init in single-profile HTTP mode; previously `upstreamMcp` was missing from `buildDefaultProfileContext`, so init validation was silently skipped.
- `setUpstreamConnectionManager` now registers the `onSessionDestroyed` cleanup listener only once; previously each call added a new listener, causing `closeAll` to be invoked multiple times per session on repeated calls.
- Query-auth upstream providers now have their token appended to the transport URL and validation endpoint URL; previously the token was never sent, causing all query-auth connections to fail authentication.
- Upstream SSE reconnect now replays buffered upstream notifications via `sendToClient()` so they enter the resumability queue and survive a second reconnect.
- `validateCredentials` now throws `UpstreamConnectionError` on non-2xx responses (404, 500, 503, etc.); previously only 401/403 were treated as failures.
- Heartbeat `setInterval` callback now skips a tick when a previous ping is still in-flight, preventing concurrent overlapping pings during upstream slowness.
- `toMcpErrorResponse` omits the `data` field when `correlationId` is absent instead of returning `{ correlationId: undefined }`.
- `validateCredentials` now uses `redirect: 'manual'` to prevent SSRF bypass via HTTP redirects pointing to private/loopback addresses; 3xx responses are treated as failures.
- `closeAll` now calls `client.close()` alongside `transport.close()` to release MCP SDK client resources (handlers, timers).
- Session init no longer logs "Upstream credential validation successful" when no client token is present and validation was a no-op.
- Hardened implementor Codex result handling with a shared JSON-schema validator, stricter prompt contract, regression coverage for malformed or over-permissive machine output (including embedded JSON after brace-like log text), and linked/corrected schema documentation from the README/agent docs.
- Hardened GitHub workflows by disabling persisted checkout credentials across local jobs and replacing the MCP scanner binary fetch with a pinned, SHA256-verified release archive plus regression coverage for workflow hardening.
- Updated the OSV reusable GitHub workflow pin to `google/osv-scanner-action` `v2.3.5` so scheduled scans stop failing on deprecated Node 20 action runtime usage.
- Hardened agent artifact rollout by wiring shipped workflows to pass `MCP4_AGENT_ARTIFACT_*`, rejecting strict trust mode without a signing key, restricting implementor artifact selection to planner-stage comments ordered by creation time, and keeping planner dedupe compatible with legacy unsigned comments while ignoring unverified signed envelopes on unsigned runs.
- Validated env-backed `upstream_mcp_from_env` entries through the Zod schema so malformed JSON (missing fields, wrong types, non-string tools policy) produces typed `ValidationError` instead of opaque `TypeError` at startup; added regression tests for the crash and silent-data-loss paths.
- Preserved proposal-intake duplicate decisions and created-issue ownership across issuer runs so reject-as-duplicate proposals persist metadata, proposal-created issues stay in the planner lane, issuer keeps proposal-intake entry labels idempotent, and proposal-intake no longer recursively re-processes issues it previously created.
- Fixed OSV scan gating for current dev dependencies by overriding transitive `flatted` to `3.4.2`, eliminating the reporter failure caused by known vulnerabilities in `3.3.3`.
- Clarified proposal-intake candidate bounds by wiring `max_candidates` separately from the single-action side-effect budget, keeping legacy env fallbacks, and documenting the one-action-per-run guardrail.
- Blocked dangerous URI schemes during URI validation to prevent XSS through attacker-controlled links and redirects.
- Removed raw environment variable values from selected configuration error messages and added regression checks to prevent secret leakage in errors.
- Hardened MCP Apps resource loading so `file_path` stays inside the profile directory after normalization and symlink resolution, while keeping `resources/read` output shape consistent across inline, file-backed, and fetch-backed resources.
- Fixed HTTP single-profile startup to carry `enterprise_authorization` into transport runtime so enterprise JWT bearer exchange and authenticated initialization work outside profile-routing mode, with dedicated E2E coverage.
- Clarified and locked runtime enterprise authorization behavior so `required` mode enforces trusted enterprise-issued bearer tokens, `optional` mode stays backward-compatible, tool-category policy covers both listing and execution, and invalid env-backed values fail during profile loading.
- Hardened approved unregistered OAuth client materialization by preserving redirect URI unions for shared compatibility `client_id` values (for example VS Code), bounding stored redirect URI payloads to client-store limits, and rejecting insecure `http://`/`https://` scheme-only allowlist rules.

## [0.5.7] - 2026-03-03


### Added
- Restored the dedicated n8n node-list profile (`n8n-nodes`) with its standalone node metadata OpenAPI spec and profile test coverage.

### Changed
- Added `session-cookie` profile auth with managed relogin/cookie rotation and an explicit `allow_shared_with_auth` cache override for authenticated shared responses.
- Updated the `n8n-nodes` profile to use `session-cookie` login for `/types/nodes.json` while keeping explicit public cache enabled for shared node metadata.
- Simplified the README opening flow with a visual "at a glance" overview, a 3-step "how it works" explanation, and a shorter quick-start entry path.

## [0.5.6] - 2026-03-02

### Changed
- Switch Cursor remote snippets to native HTTP config, update docs for token validation and multi-auth with validation examples.

## [0.5.5] - 2026-03-02

### Added
- Added global `MCP4_PARAM_FILTER` / `--param-filter` baseline enforcement for `stdio` and `http`, and extended HTML profile-index filter builders to emit local stdio filter args (`--tool-filter-allow-*`, `--param-filter`) while still using `X-Mcp4-Tools` / `X-Mcp4-Params` for remote HTTP snippets.
- Added tri-state bulk selection toggles to the profile-index tool and parameter filter sections for one-click select-all/clear-all behavior with mixed-state visibility.

### Changed
- Updated Cursor remote HTTP snippets to use native `url` + `headers` + `env` config instead of `mcp-remote`, with sandbox variable references in request headers/query values and `${env:VAR}` only in the `env` copy-through map.

## [0.5.4] - 2026-02-27


## [0.5.3] - 2026-02-25


### Added
- Added `prepare-release-publishing` skill with a tested `patch|minor|major` workflow that inserts dated release headings under `Unreleased`, runs `npm version`, and verifies version consistency against `package.json`.

### Fixed
- Fixed CLI standard flags so `--help`/`-h` prints usage and `--version`/`-v` prints package version without requiring OpenAPI/profile startup configuration.
- Hardened response-cache correctness by honoring request `Cache-Control: no-store`, preserving duplicate query-parameter order in cache keys, and strictly validating `max_memory_bytes_from_env` numeric values.
- Tightened HTTP cache RFC behavior with conditional revalidation (`ETag`/`If-None-Match`, `Last-Modified`/`If-Modified-Since`, `304` merge), request/response `no-cache` and `no-store` safeguards, public-scope `private` and auth protections, `Vary` validation, robust directive parsing, and successful unsafe-method cache invalidation with dedicated tests.
- Fixed HTTP tenant/session token auth flow so interceptor auth no longer requires `value_from_env` when a valid session token is already provided via MCP initialization headers.

## [0.5.1] - 2026-02-24

### Added
- Added profile-configurable in-memory response caching (`interceptors.cache`) with TTL, request deduplication, LRU eviction, and hard `max_memory_bytes` budget limits.

### Fixed
- Fixed HTTP profile index API endpoint/snippet rendering to prefer env-overridden base URLs over profile defaults, so displayed n8n endpoints match effective runtime configuration.

## [0.5.0] - 2026-02-22

### Added
- Added HTTP tenant session override with deterministic exact and `mask:` selectors, startup/runtime collision guards, path-segment wildcards (`*`) for mask URLs, required `profile_ids` tenant scoping, and profile-index tenant metadata with interactive header injection (`X-Mcp4-Tenant-Id`, plus example `X-Mcp4-Api-Base-Url` for `mask:` tenants) including explicit "no tenant" profile-default selection when available.
- Added bundled Codecov OpenAPI profile with CRUD-style aggregated tools (`retrieve_content`, `update_content`), profile aliases, and schema-driven action coverage tests.

### Fixed
- Normalized profile route param handling to accept Express string-array params while preserving `McpRequest.profileId` as `string | undefined`.
- Fixed Vitest v4 regressions in mocked constructor tests and MCP handler lookup tests to keep the suite stable after test-runner upgrades.
- Fixed profile schema sync generation on Node runtimes without `fs.globSync` by falling back to tsconfig-based source discovery.
- Fixed OSV scan gating by pinning direct `ajv` usage to `^8.18.0` and adding a temporary documented ignore for the unresolved `eslint` dev-only transitive `ajv@6.12.6` finding.
- Hardened OAuth in-memory client store limits with configurable env/constructor overrides, idle-grace configuration, active-usage-aware eviction policy, and deterministic 429 responses when no safe eviction candidate exists.
- Fixed proxy-download SSRF policy regression so same-origin URLs remain allowed when `allowed_hosts` is configured for cross-origin `skip_auth` flows, while still enforcing private-network SSRF checks.

### Changed
- Refreshed lockfile with latest non-breaking dependency updates available under current semver ranges.
- Upgraded the dev test/lint toolchain to eslint 10 and Vitest 4, replaced `typescript-json-schema` with `ts-json-schema-generator`, and updated schema-sync generation scripts accordingly.
- Updated Vitest configuration to v4 worker options (`maxWorkers`, `isolate`, `fileParallelism`) to remove deprecated `poolOptions` usage.
- Extended local stdio profile-index snippets for Claude Code CLI and Gemini (JSON + CLI) to include API base URL env wiring, and enabled tenant API-base override injection for Gemini local JSON snippets.
- Added `profile_id` and `tenant_id` labels to HTTP/session/tool/API Prometheus metrics with explicit fallbacks (`unknown`/`none`) to support tenant-aware observability.

## [0.4.0] - 2026-02-16

### Added
- Added profile-defined MCP prompt support (`prompts/list`, `prompts/get`) with prompt schema types, runtime rendering, and HTTP/SDK test coverage.
- Added DefectDojo read-only profile and smoke test profile for healthcheck, token reports, and metrics endpoints.
- Added Gemini CLI snippets to HTTP profile index for remote streamable HTTP and local stdio configuration (JSON + CLI).

### Changed
- Generic profile test runner now resolves OpenAPI spec from profile `openapi_spec_path` first and only falls back to `openapi.*` convention.
- HTML profile index now shows more specific set of configurations for each profile.
- HTTP initialize auth gate now preserves `value_from_env` server-token fallback while still rejecting unauthenticated init when no fallback token is available.

## [0.3.9] - 2026-02-10

### Fixed
- Fixed some Collabim optimized profile filter parameter types to use boolean values instead of numeric enums.

## [0.3.8] - 2026-02-10

### Changed
- Hardened HttpClient security with SSRF validation across redirect hops, configurable request timeout (timeout_ms, default 30s), and cross-origin auth-header stripping.

## [0.3.7] - 2026-02-08

### Added
- Added a new GitHub Security profile for code scanning alerts (list/get/instances/update) with dedicated OpenAPI spec and profile test coverage.
- Added missing Collabim profile test definition and aligned optimized Collabim test coverage rules so the profile coverage gate passes.

### Changed
- Hardened auth token validation endpoint handling: absolute URLs now require base-origin match or explicit `validation_allowed_hosts`, with SSRF host allowlist enforcement.

## [0.3.6] - 2026-02-08

### Changed
- Use COLLABIM_TOKEN as auth environment variable in profile configuration.

## [0.3.5] - 2026-02-08

### Added
- Added Collabim API Blueprint assets with generated OpenAPI spec plus a CRUD-oriented optimized profile and profile tests.

### Changed
- Refactored SSRF IP range checks to use CIDR matching via ipaddr.js.
- Updated @modelcontextprotocol/sdk to 1.26.0 (security fix).
- Defaulted generated string schemas to a 4096 maxLength when pattern is set without maxLength to reduce ReDoS risk.
- Hardened OAuth/bootstrap security
- Changed OAuth default limits to 10 requests per 1 minute while keeping OAuth state timeout at 10 minutes.
- Added nightly and manual MCP security scanning workflow with SARIF upload to GitHub Security tab.
- Automated profile schema synchronization from TypeScript types with drift-check tooling for Zod and JSON schema outputs.

## [0.3.4] - 2026-02-05

### Fixed
- Versions sync

## [0.3.3] - 2026-02-05

### Added
- Added HTTP profile routing allowlist controls (`MCP4_ALLOW_PROFILES`, `MCP4_ALLOW_PROFILES_REGEX`) for allowed profile ids/names/aliases with optional regex matching.
- GitLab profiles now expose common list filters for projects, issues, merge requests, and issue notes (including owned and membership for projects).

### Changes
- Docker image now bundles profiles and HTML assets.

### Fixed
- GitLab GLQL request schema now uses glql_yaml to match API requirements.

## [0.3.2] - 2026-02-03

### Added
- Added GitLab CRUD-oriented profile.
- Added Grafana OpenAPI spec and CRUD-oriented Grafana profile.
- Added Mattermost OpenAPI spec and CRUD MCP profile covering users, teams, channels, posts, files, reactions, and threads.

### Changed
- Enhance GitLab OpenAPI/profiles with new issue and MR functionalities.
- Standardized CRUD-oriented n8n-optimized profile.

## [0.3.1] - 2026-02-03

### Added
- Added optional HTTP profile index page for routed profiles, including connection snippets and auth-aware guidance.

### Changed
- Updated bundled profile descriptions to clarify access-style vs operation-style tools and show concrete API-to-tool reduction counts.

## [0.3.0] - 2026-01-31

### Added
- Metrics collection for external API calls and errors.
- Validation for base64 input in tool generator.
- Profile routing with trust proxy support, plus profile-scoped OAuth metadata and protected-resource endpoints (including RFC 8414 path-suffix routes).
- n8n OpenAPI specification and MCP profiles, plus node list metadata API and workflow management updates.
- Support for custom authentication headers based on profile configuration.
- Support for root array request bodies and quoted field names in MCPServer.
- Bundled profiles in the npm package and CLI listing via `--list-profiles`/`-l`.
- Missing defense-in-depth security headers.

### Changed
- Refactor: group src files by domain folders.
- Update GitLab profile and API to support pagination and default parameter values.
- Prioritize header tokens over session tokens.
- Update hono dependency to 4.11.7.
- Profile resolution now falls back to bundled profiles when `./profiles` is missing.
- docs: update PROFILE-GUIDE.md to clarify required inputs for MCP tool profiles.
- docs: update AGENTS.md to replace multi-auth section with profile testing strategies.
- docs: add finding regarding OAuth pre-registered client for VS Code and clarify false positive handling.
- docs: update README to include MCP architecture diagram and improve profile descriptions.
- docs: add CLAUDE.md and GEMINI.md files referencing @AGENTS.md.

### Fixed
- ConsoleLogger sanitization to prevent log injection (strip ANSI escape codes and escape control characters).
- Path segments encoding.
- Preserve profile-scoped OAuth metadata from resource URL.

## [0.2.8] - 2025-12-20

### Added
- YouTrack profile support for project custom fields, including new actions and response field selection for project custom field details.

### Changed
- HTTP transport now uses typed errors and correlation IDs for client-facing responses, with stricter token/header validation.
- Proxy downloads validate URL schemes/origins, enforce redirect limits, and add allowlist/private-network controls.

## [0.2.7] - 2025-12-18

### Changed
- Stabilized GitLab E2E suites by reusing a single mock server and MCP process per file, reducing startup/shutdown overhead.
- Hardened HTTP transport config tests by mocking `HttpTransport` construction, ensuring environment-derived settings are exercised.

## [0.2.6] - 2025-12-17

### Added
- GitLab OpenAPI/profile coverage for merge-request discussions, approvals, snippet downloads, and job artifact proxy downloads so developers can fetch diffs/attachments even when GitLab is private.
- Improved GitLab E2E suite covering pipelines/jobs, snippet proxy downloads, and merge-request workflows to guard against regressions in high-risk flows.

## [0.2.5] - 2025-12-15

### Added
- Optimized YouTrack profile with parameter aliases and `proxy_download` operations for attachment retrieval (bearer auth and size guardrails).
- `ProxyDownloadExecutor` that fetches metadata, validates MIME type/size, and returns base64 content with optional auth bypass on final download.
- Bundled YouTrack assets (full OpenAPI spec plus optimized and minimal profiles) wired for env-based base URL/token injection, curated response fields, and attachment download coverage in integration/E2E tests.

### Changed
- Query parameter aliasing now works for YouTrack search operations, aligning OpenAPI names with profile-friendly parameters and extending coverage in parameter-mapping tests.
- YouTrack issue responses keep curated fields plus attachments/comments to ensure proxy downloads have the required context.
- Removed the default YouTrack base URL so deployments must provide an explicit environment-driven base URL (tests use a mock server by default).

## [0.2.4] - 2025-12-04

### Added
- Automated publishing to npmjs.org and GitHub Packages on tag
- Release process documentation (docs/RELEASING.md)
- End-to-end (E2E) test job in CI workflow
- Multi-auth configuration with priority-based fallback in PROFILE-GUIDE.md
- OAuth rate limiting configuration in PROFILE-GUIDE.md
- Token validation configuration (validation_endpoint) in PROFILE-GUIDE.md

### Changed
- CI workflow now requires all tests (unit + e2e) to pass before publishing
- Improved test coverage for `validation-utils.ts` and `oauth-provider.ts`
- Docker images are now built for both amd64 and arm64 architectures
- Updated documentation to clarify validation_endpoint is relative to base URL

### Fixed
- DNS rebinding protection and minor security fixes
- Profile validation fixes
- TypeScript error in oauth-provider.test.ts (clientsStore possibly undefined)
- Documentation and comments for OIDC and publishing steps
- Fixed broken DEPLOYMENT-K8S-OAUTH.md reference in README

## [0.2.3] - 2025-12-01

### Added
- Support for HTTP/HTTPS URLs in `MCP4_OPENAPI_SPEC_PATH`

### Changed
- Improved test coverage

### Fixed
- Minor security fixes

## [0.2.2] - 2025-11-30

### Added
- Security hardening: prototype pollution protection via `isSafePropertyName()`
- Security hardening: ReDoS prevention via `escapeRegExp()`
- Security hardening: OAuth redirect URI validation against `MCP4_ALLOWED_ORIGINS`
- Security hardening: CORS origin validation (no longer reflects user input)
- Docker hardening: `read_only`, `no-new-privileges`, `tmpfs` options

### Changed
- Refactored `ConsoleLogger` and `JsonLogger` to use shared redaction utilities from `validation-utils.ts`

## [0.2.1] - 2025-11-29

### Added
- Codecov integration with coverage badge
- CI workflow with test analytics (JUnit XML reporter)

## [0.2.0] - 2025-11-28

### Added
- HTTP Streamable transport (MCP Specification 2025-03-26)
- OAuth 2.0 authentication with PKCE flow
- Multi-auth support (OAuth + Bearer fallback)
- Prometheus metrics endpoint (`/metrics`)
- Session management with SSE resumability
- Rate limiting for HTTP and OAuth endpoints
- DAG-based parallel execution for composite tools
- Profile-aware token redaction in logs

### Changed
- Migrated from `/sse` to `/mcp` endpoint (legacy alias maintained)

## [0.1.0] - 2025-11-15

### Added
- Initial release
- OpenAPI 3.x specification support
- Profile-based tool aggregation
- Composite tools for multi-step workflows
- Bearer, custom-header, and query authentication
- Rate limiting with token bucket algorithm
- Exponential backoff retry logic
- Schema validation for request bodies
- Structured logging (console/JSON)

[Unreleased]: https://github.com/davidruzicka/mcp4openapi/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.8...v0.3.0
[0.2.8]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/davidruzicka/mcp4openapi/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/davidruzicka/mcp4openapi/releases/tag/v0.1.0
