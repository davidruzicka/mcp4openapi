# Roadmap: Enterprise MCP Gateway

## Milestones

- ✅ **v1.0 Enterprise MCP Gateway** — Phases 1-4 (shipped 2026-05-19)
- 📋 **v1.1** — Phases 5-6 (planned)

## Phases

<details>
<summary>✅ v1.0 Enterprise MCP Gateway (Phases 1-4) — SHIPPED 2026-05-19</summary>

- [x] Phase 1: Upstream Session Foundation (5/5 plans) — completed 2026-03-30
- [x] Phase 2: Tool Discovery and Call Proxy (3/3 plans) — completed 2026-03-30
- [x] Phase 3: Client Authentication Gate (API Keys) (3/3 plans) — completed 2026-04-30
- [x] Phase 03.1: Remove multi-upstream MCP support (3/3 plans) — completed 2026-04-30 (INSERTED)
- [x] Phase 03.2: Profile env-var description field (3/3 plans) — completed 2026-05-05 (INSERTED)
- [x] Phase 03.3: Graceful OAuth degradation (2/2 plans) — completed 2026-05-05 (INSERTED)
- [x] Phase 03.4: Encrypted token envelope (4/4 plans) — completed 2026-05-11 (INSERTED)
- [x] Phase 4: Observability (2/2 plans) — completed 2026-05-18

See `.planning/milestones/v1.0-ROADMAP.md` for full phase details.

</details>

### 📋 v1.1 (Planned)

- [ ] **Phase 5: Upstream OAuth Proxy** — Gateway-initiated OAuth authorization code flow against upstream MCP servers; encrypted refresh token payload in gateway token; zero-reauth on restart
- [ ] **Phase 6: Client Authentication Gate (OIDC JWT)** — JWT/JWKS identity verification, OIDC discovery, session identity completion (closes AUTH-01)

## Progress

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (03.1, 03.2, 03.3, 03.4): Urgent insertions between Phase 3 and Phase 4

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Upstream Session Foundation | v1.0 | 5/5 | Complete | 2026-03-30 |
| 2. Tool Discovery and Call Proxy | v1.0 | 3/3 | Complete | 2026-03-30 |
| 3. Client Auth Gate (API Keys) | v1.0 | 3/3 | Complete | 2026-04-30 |
| 03.1. Remove multi-upstream support | v1.0 | 3/3 | Complete | 2026-04-30 |
| 03.2. Profile env-var descriptions | v1.0 | 3/3 | Complete | 2026-05-05 |
| 03.3. Graceful OAuth degradation | v1.0 | 2/2 | Complete | 2026-05-05 |
| 03.4. Encrypted token envelope | v1.0 | 4/4 | Complete | 2026-05-11 |
| 4. Observability | v1.0 | 2/2 | Complete | 2026-05-18 |
| 5. Upstream OAuth Proxy | v1.1 | 0/3 | Not started | - |
| 6. Client Auth Gate (OIDC JWT) | v1.1 | 0/3 | Not started | - |
