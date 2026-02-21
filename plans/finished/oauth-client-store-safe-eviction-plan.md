# OAuth Client Store Safe Eviction Plan

## Goal
- Prevent eviction of actively used OAuth dynamic clients while preserving DoS protection against mass dummy registrations.
- Keep behavior deterministic, modular, and testable.

## Principles
- Data-oriented policy decisions (tier tables + scoring), not ad-hoc if/else chains.
- Strong module boundaries and single responsibility.
- Typed errors only, no ad-hoc error strings.
- Incremental delivery in small PRs with passing tests at each step.

## Checklist
- [x] Create and publish this implementation plan in `plans/`.

### PR 1 - Structural refactor (no behavior change)
- [x] Extract `InMemoryClientsStore` into `src/auth/client-store/in-memory-clients-store.ts`.
- [x] Add store domain types to `src/auth/client-store/types.ts`.
- [x] Keep `src/auth/oauth-provider.ts` as orchestrator using the extracted store.
- [x] Keep runtime behavior identical (parity check by existing tests).
- [x] Run `npm run typecheck`.
- [x] Run focused tests for OAuth provider/store.

### PR 2 - Usage metadata model
- [x] Add per-client runtime metadata: `createdAt`, `lastUsedAt`, `activeSessionCount`, `pendingStateCount`, `pendingAuthCodeCount`, `kind`.
- [x] Add deterministic clock injection for tests (`nowProvider`).
- [x] Add explicit mark methods in store (`markClientUsed`, `markSessionAttached`, `markSessionDetached`, `markAuthStateOpened`, `markAuthStateClosed`, `markAuthCodeOpened`, `markAuthCodeClosed`).
- [x] Add underflow guards for counters and tests for guard behavior.
- [x] Run `npm run typecheck`.
- [x] Run unit tests for metadata transitions.

### PR 3 - Data-driven eviction policy module
- [x] Create `src/auth/client-store/policy.ts` with pure selection logic.
- [x] Define eviction tiers:
- [x] Tier A: dynamic + idle + never used.
- [x] Tier B: dynamic + idle.
- [x] Tier C: any + idle.
- [x] Return deterministic `no-candidate` decision when no safe candidate exists.
- [x] Add exhaustive unit tests in `src/auth/client-store/policy.test.ts`.
- [x] Run `npm run typecheck`.
- [x] Run policy unit tests.

### PR 4 - OAuth lifecycle integration
- [x] Wire store lifecycle markers into OAuth provider state/code lifecycle.
- [x] Mark usage on client read paths relevant to callback/token exchange.
- [x] Ensure cleanup paths decrement pending state/code counters correctly.
- [x] Add integration tests proving pending state/code clients are not evicted.
- [x] Run `npm run typecheck`.
- [x] Run focused OAuth integration tests.

### PR 5 - HTTP session lifecycle integration
- [x] Wire store attach/detach updates from session lifecycle using `session.oauthClientId`.
- [x] Ensure all session termination paths detach usage (explicit close, timeout cleanup, error paths).
- [x] Add integration tests proving active-session clients are not evicted.
- [x] Run `npm run typecheck`.
- [x] Run focused HTTP transport OAuth/session tests.

### PR 6 - Safe failure when no evictable candidate exists
- [x] Add/choose typed error for full store without safe candidate in `src/core/errors.ts`.
- [x] Map this error to a deterministic HTTP response in `/oauth/register`.
- [x] Preserve observability context (correlation id and safe metadata).
- [x] Add tests for HTTP status + payload mapping on this failure path.
- [x] Run `npm run typecheck`.
- [x] Run focused tests for registration failure behavior.

### PR 7 - Configuration and documentation
- [x] Keep existing env limits and validate precedence (constructor options > env > defaults).
- [x] Optionally add policy env knob(s) if needed (e.g. idle grace).
- [x] Update `README.md`, `docs/OAUTH.md`, and `env.example` with final behavior.
- [x] Update `CHANGELOG.md` with a concise user-facing summary.
- [x] Run `npm run typecheck`.
- [x] Run focused tests for config behavior.

## Acceptance Criteria
- [x] Active OAuth clients are never evicted when an idle candidate exists.
- [x] Dummy/unused dynamic registrations are evicted first under pressure.
- [x] Behavior is deterministic and covered by unit + integration tests.
- [x] Full-store/no-safe-candidate path returns typed, documented error behavior.
- [x] Documentation and env reference are synchronized with implementation.

## Execution Notes
- Check off each item immediately after completion.
- Keep commits small and scoped to one checklist group at a time.
- Prefer one feature slice per PR, merged with green typecheck/tests.
