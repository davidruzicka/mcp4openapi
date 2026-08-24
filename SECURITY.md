# Security — known weaknesses and accepted residual risks

This file documents security-relevant design trade-offs that are **accepted and
shipped**, plus the open hardening items tracked in [TODO.md](TODO.md). It is the
place a reviewer or AppSec should check before re-reporting a known limitation.

## Accepted residual risks

### Cross-instance approval replay (consent gate)

One-time consumption of the consent approval token
(`src/transport/consent-http-controller.ts`) is exact only within a single
instance: the consumed-signature set is in-memory and not shared across
replicas or restarts. A token consumed on replica A is still accepted by
replica B within its TTL.

Why accepted: a replay requires the victim's approval token **and** the
matching `__Host-` cookie, is bound to one exact OAuth request (fingerprint)
and a short TTL (`MCP4_CONSENT_APPROVAL_TTL_MS`, default 5 min), and can only
re-run that client's own authorization — it grants no new access. Exact
cross-replica one-time semantics would put a shared store (Postgres) into the
interactive consent path; if AppSec ever requires it, the evidence-store
backend can host the consumed set (see the alternatives in the AIPP-521
decision record).

Covered by test: `accepts a cross-instance replay of a consumed token` in
`consent-http-controller.test.ts`.

### Consumed-approval eviction bound (consent gate)

The per-instance replay guard is bounded at `MCP4_CONSENT_CONSUMED_MAX`
(default 10000, FIFO eviction). Evicting a consumed marker makes that one
token replayable again **on this instance**.

Why accepted: reaching the bound requires ~10000 *successful* consent
consumptions (each needs a validly fingerprinted, registered OAuth request),
and the replay still requires the victim's token plus cookie within the TTL.
The bound exists to cap memory, mirroring the sibling OAuth stores.

## Open hardening items (tracked in TODO.md)

Security-relevant subset; numbers reference [TODO.md](TODO.md) sections.

| # | Item | Exposure |
|---|------|----------|
| 7 | ReDoS protection in the regex compiler covers known patterns but has no matching timeout or input-length cap | DoS via crafted `X-Mcp4-Tools` header or env regex |
| 12 | Profile hint keys derive from IP + user-agent only; clients behind one NAT with identical agents can overwrite each other's hints | Profile misrouting for OAuth endpoints |
| 14 | OAuth redirect URI schemes use a denylist (`javascript:`, `data:`, ...) instead of a strict allowlist | Unlisted dangerous scheme would pass |
| 15 | Tenant auth compatibility compared via `JSON.stringify` fingerprint | Fragile equality for nested `oauth_config` |
| 17 | SSRF validation for `SasankaApiKeyStore` `base_url` is lazy (first session), not at profile load | Misconfiguration surfaces late, under load |
| 18 | Legacy unsalted SHA-256 token-envelope KDF fallback still accepted for pre-migration envelopes | Weak KDF window; safe to remove 30 days after the scrypt migration ships |
| 20 | Consent hardening remainder: no Prometheus counters for approval/denial/expired-token events, CSP polish pending | Reduced detection capability |
| 21 | Authorization-code replay revokes the access token but not the refresh rotation family from the first redemption | Partial replay revocation (PKCE limits practical impact) |
| 22 | PKCE `code_challenge_method` contract differs between transport (explicit S256) and provider (defaults to S256) | Looser contract for a future direct provider caller |
| 26 | `consumedCodeTombstones` has TTL but no hard size cap, unlike sibling stores | Memory growth on the rate-limited token endpoint |

When one of these lands, remove its row here and the TODO section together.
