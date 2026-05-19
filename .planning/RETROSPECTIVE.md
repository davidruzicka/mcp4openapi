# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Enterprise MCP Gateway

**Shipped:** 2026-05-19
**Phases:** 8 | **Plans:** 25 | **Tasks:** 58

### What Was Built

- Upstream session lifecycle: per-session `UpstreamConnectionManager` with lazy connect, concurrent dedup, heartbeat pings, credential pass-through, and session-scoped teardown
- Tool forwarding pipeline: tools/list + tools/call proxied with sanitization (injection-safe), typed error mapping, and tools/list_changed notification relay with bounded queue replay
- M2M API key auth gate: HMAC-SHA256 constant-time comparison; clientPrincipal on session before any upstream connection; fail-fast profile validator at load time
- AES-256-GCM encrypted token envelopes for restart-resilient OAuth sessions in k8s (no persistent storage)
- Graceful OAuth degradation when config incomplete; admin-supplied HTML descriptions per profile; upstream_mcp singular type constraint
- Full observability: per-tool structured audit log + Prometheus upstream_host/client_identity dimensions + /ready readiness probe

### What Worked

- Decimal phase insertions (03.1, 03.2, 03.3, 03.4) let urgent work land between planned phases without renumbering or disrupting the roadmap
- Data-driven patterns (lookup tables, factory registries) kept auth extension points clean — Phase 6 OIDC path can be added without touching Phase 3 core
- Test-first contract: acceptance criteria written as grep/exist checks before implementation reduced rework during verification
- Fail-fast at startup (invalid JSON, duplicate keys, missing env vars) caught misconfiguration before requests; no silent failures in production paths

### What Was Inefficient

- VERIFICATION.md for Phase 04 was written before gap-fix commits and not re-run — left stale status in planning docs; adds noise to future audits
- Several SUMMARY.md files missing structured `one_liner` fields — gsd-tools summary-extract returned empty output; accomplishments had to be reconstructed manually
- Traceability table in REQUIREMENTS.md had stale phase numbers from early in the milestone (AUTH-01 "Phase 4", OBS-* "Phase 5") — not caught until audit

### Patterns Established

- `isEncryptedToken()` prefix guard before any decrypt attempt — makes token-type dispatch explicit and cheap
- `emitAuditToolCall` single-source helper: one grep target across all tool-call outcomes prevents audit-shape drift
- Per-instance HMAC secret in `InlineApiKeyStore` (not global) — timing-safe comparison works correctly for variable-length keys without leaking length information
- `oauthDisabledReason` in `ProfileRuntimeState` as the single flag checked by auth gate, HTML renderer, and log — clean degradation without scattered null checks

### Key Lessons

1. Write VERIFICATION.md after gap fixes are confirmed in code, not before — pre-fix reports in planning docs create audit noise
2. Add `one_liner` to SUMMARY.md frontmatter at plan completion time, not retroactively — used by milestone archival
3. Keep REQUIREMENTS.md traceability table phase numbers current at each phase transition — stale refs compound over a long milestone
4. AUTH-01 (OIDC JWT) was always Phase 6 but REQUIREMENTS.md said "Phase 4" since initial draft — traceability should be updated at each roadmap revision, not just at milestone end

### Cost Observations

- Sessions: ~930 commits across milestone
- Notable: decimal phase insertions added 4 unplanned phases (03.1-03.4) without disrupting phases 4-6; roadmap remained coherent

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Change |
|-----------|--------|-------|------------|
| v1.0 | 8 | 25 | Decimal phase insertions for urgent mid-milestone work; GSD workflow established |

### Cumulative Quality

| Milestone | Tests | Key Additions |
|-----------|-------|---------------|
| v1.0 | 3333+ | Upstream proxy pipeline, M2M auth gate, AES-GCM token envelopes, structured observability |

### Top Lessons (Verified Across Milestones)

1. Fail-fast at startup is always worth the extra validation code — silent misconfiguration is harder to debug than a clear startup error
2. Single-source audit/metric helpers prevent shape drift across many call sites — write the helper before wiring, not after
