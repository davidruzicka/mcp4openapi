# HTTP Tenant `mask:` Selector - Implementation Plan

## Goal
Add deterministic hostname mask support for tenant selection in HTTP transport, using `mask:` values in `api_base_url` (for example `mask:https://grafana.*.security.*.ops.iszn.cz`) while preserving backward compatibility for exact URLs.

## Scope
- Keep existing exact URL behavior unchanged.
- Add `mask:` selector support with strict validation.
- Detect selector collisions at startup and fail fast.
- Keep session tenant selection immutable and deterministic.
- Keep current API endpoint display behavior in profile index (env/default source resolution) unchanged.
- Extend HTML profile index with per-profile tenant availability and tenant list when tenant config is enabled.
- Add optional interactive tenant picker in profile index for a subset of clients with verified header support.

## Locked Decisions
- [ ] `tenant_id` stays mandatory in tenant configuration for both exact and `mask:` entries.
- [ ] For exact selectors, client can select tenant by `X-Mcp4-Tenant-Id` or by `X-Mcp4-Api-Base-Url`.
- [ ] For `mask:` selectors, concrete URL selection requires `X-Mcp4-Api-Base-Url`; `X-Mcp4-Tenant-Id` is optional guard and must match resolved tenant when present.
- [ ] Profile index tenant data is per-profile (not global payload-wide list).
- [ ] Interactive tenant picker is rendered only for snippet/client formats with verified custom-header support.
- [ ] URL normalization and comparison behavior for `mask:` matching follows the same semantics as non-mask `api_base_url` handling.

## Plan Checklist
- [ ] Define selector model and parsing rules in `src/transport/http-tenant-config.ts` for `api_base_url` values (`exact` vs `mask:`).
- [ ] Implement URL and mask normalization helpers (scheme, host, optional port, path, trailing slash normalization, no credentials/query/fragment).
- [ ] Implement `mask:` grammar validation:
  - wildcard `*` allowed only as a full host label
  - literal host labels limited to `[a-z0-9-]+`
  - path must be literal (no wildcard)
  - default `https`, `http` allowed only with `MCP4_HTTP_TENANTS_ALLOW_HTTP=true`
- [ ] Extend tenant index structures in `src/types/http-tenants.ts` and `src/transport/http-tenant-config.ts` to store exact selectors and compiled/normalized mask selectors.
- [ ] Implement deterministic resolution order in `resolveTenantFromHeaders()`:
  1. `tenant_id` header
  2. exact `api_base_url` selector
  3. `mask:` selector
  4. default tenant fallback
- [ ] Enforce header semantics for selector consistency:
  - exact tenant selected by `tenant_id` may resolve without `X-Mcp4-Api-Base-Url`
  - `mask:` tenant requires `X-Mcp4-Api-Base-Url` to resolve concrete endpoint
  - when both headers are present, they must resolve to the same tenant or fail with `400 ValidationError`
- [ ] Implement startup collision detection and fail fast with typed `ValidationError`:
  - exact vs exact
  - exact vs mask
  - mask vs mask (non-empty intersection by deterministic mask intersection rules)
- [ ] Add runtime ambiguity guard: if one input URL matches multiple mask tenants, return `400 ValidationError`.
- [ ] Tighten session immutability checks in `src/transport/http-transport.ts` to validate both `tenantId` and resolved `tenantBaseUrl` on non-initialize requests when selector headers are sent.
- [ ] Add/extend unit tests in `src/transport/http-tenant-config.test.ts`:
  - valid `mask:` matching with one and multiple wildcard labels
  - invalid masks rejected
  - startup collision failures
  - runtime ambiguity failure
  - backward compatibility for exact selectors
- [ ] Add/extend HTTP transport tests in `src/transport/http-transport.test.ts`:
  - initialize using mask-selected tenant
  - non-initialize mismatch rejection for changed base URL under same tenant id
  - exact selector precedence over mask selector
- [ ] Update documentation in `docs/HTTP-TRANSPORT.md`:
  - selector format and examples
  - deterministic resolution order
  - collision and ambiguity behavior
  - security constraints
- [ ] Update user-facing docs in `README.md`:
  - introduce `mask:` selector usage for tenants
  - document tenant selector headers and initialization behavior
  - link to HTTP transport tenant section for detailed rules
- [ ] Extend profile index payload model in `src/transport/profile-index.ts` (and related types) with optional per-profile tenant summary fields:
  - `tenantsEnabled` flag
  - tenant list (`tenant_id`, selector display string, default marker)
  - selected header strategy for UI injection (`X-Mcp4-Tenant-Id`)
- [ ] Build tenant summary for profile index in `src/transport/http-transport.ts` from loaded tenant config and pass it into profile payload generation without changing API endpoint source rendering.
- [ ] Extend HTML profile index UI in `html/profile-index.html`:
  - keep existing API endpoint card output unchanged
  - render "tenants available" information only when tenant config is present
  - render tenant list with default tenant highlight
  - make tenant items interactive (click/keyboard)
- [ ] Implement interactive snippet augmentation in `html/profile-index.html`:
  - on tenant selection, inject `X-Mcp4-Tenant-Id: <tenant_id>` into remote snippet variants
  - render picker/injection only for client snippet formats with verified custom-header support
  - keep local stdio snippets unchanged
  - update copy payload to reflect current tenant selection
  - keep behavior deterministic when snippet already has headers
- [ ] Add/extend tests for profile index behavior:
  - `src/transport/profile-index.test.ts` for tenant payload + rendering data
  - `src/transport/http-transport.test.ts` for `/` JSON payload tenant metadata
  - focused assertions for tenant header injection in rendered HTML payload
- [ ] Run verification:
  - targeted tenant tests (`http-tenant-config` and `http-transport`)
  - profile index tests (`profile-index` helpers and transport profile-index route tests)
  - `npm run typecheck`

## Acceptance Criteria
- [ ] Existing exact `api_base_url` tenant configs continue to work without changes.
- [ ] `mask:` selectors support multi-level wildcard host patterns as agreed.
- [ ] Ambiguous or colliding selectors are rejected (startup and runtime defense-in-depth).
- [ ] For `mask:` selectors, request without concrete `X-Mcp4-Api-Base-Url` is rejected; when both tenant headers are present they must resolve consistently.
- [ ] Session tenant context stays immutable across requests.
- [ ] Profile index keeps current API endpoint display semantics and adds per-profile tenant availability/list only when configured.
- [ ] Interactive tenant selection updates copy output for supported remote snippet formats only.
- [ ] Documentation reflects final behavior and constraints in both `docs/HTTP-TRANSPORT.md` and `README.md`.
