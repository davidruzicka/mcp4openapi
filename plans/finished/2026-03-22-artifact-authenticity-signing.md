# Artifact Authenticity / Signing Hardening Plan

> **For Hermes:** Use the subagent-driven-development skill to execute this plan task-by-task.

**Goal:** Add trusted, signed planner/review-follow-up artifacts so downstream automation can distinguish agent-produced handoff data from untrusted user text and fail closed on execution paths.

**Architecture:** Keep the current planner artifact payload shape as the canonical business object, but wrap it in a versioned signed envelope on emission. Separate three concerns: (1) raw extraction from comment bodies, (2) cryptographic verification + trust decisions, and (3) trusted consumption in planner/implementor execution paths. Planner dedupe remains lenient/read-only; implementor execution becomes strict/fail-closed.

**Tech Stack:** TypeScript, Vitest, Node `crypto` HMAC, existing GitHub agent runner scripts, existing `ConfigurationError` / structured error patterns in `src/core/errors.ts`.

---

## Canonical references to review before editing

- `docs/AUTONOMOUS-AGENTS.md`
- `docs/roadmaps/agent-development-support.md`
- `docs/plans/2026-03-19-pr1-review-follow-up-loop.md`
- `src/automation/planner-artifact.ts`
- `src/automation/planner-artifact.test.ts`
- `src/automation/planner-runner.ts`
- `src/automation/planner-runner.test.ts`
- `src/automation/implementor-runner.ts`
- `src/automation/implementor-runner.test.ts`
- `src/automation/implementor-codex.ts`
- `src/automation/implementor-codex.test.ts`
- `scripts/run-planner.ts`
- `scripts/run-implementor.ts`
- `scripts/run-implementor-codex.ts`
- `scripts/github-agent-runtime.ts`
- `src/core/errors.ts`
- `src/tool-filter/config/env-config-parser.ts` (style reference for env parsing)

## Scope boundary for this pass

In scope:
- versioned signed envelope for planner/review-follow-up artifacts
- env-driven signing/verification config
- shared HMAC signing + verification primitives
- trusted vs untrusted artifact parsing split
- fail-closed implementor consumption of unsigned/invalid artifacts
- lenient planner dedupe behavior for malformed/unsigned artifacts
- tests for valid, missing, invalid, tampered, and compatibility-mode cases
- docs update for trust boundary, keys, and failure behavior

Out of scope:
- signing all `AGENT-METADATA` blocks
- asymmetric crypto / keypair distribution
- merger-specific trusted artifact consumption unless a concrete path is identified during implementation
- broad workflow redesign outside planner -> implementor artifact handoff

---

## Proposed files

**Create**
- `src/automation/artifact-signing.ts`
- `src/automation/artifact-signing.test.ts`
- `src/automation/artifact-signing-config.ts`
- `src/automation/artifact-signing-config.test.ts`
- `docs/plans/2026-03-22-artifact-authenticity-signing.md` (this file)

**Modify**
- `src/automation/planner-artifact.ts`
- `src/automation/planner-artifact.test.ts`
- `src/automation/planner-runner.ts`
- `src/automation/planner-runner.test.ts`
- `src/automation/implementor-runner.ts`
- `src/automation/implementor-runner.test.ts`
- `src/automation/implementor-codex.ts`
- `src/automation/implementor-codex.test.ts`
- `scripts/run-planner.ts`
- `scripts/run-implementor.ts`
- `scripts/run-implementor-codex.ts`
- `docs/AUTONOMOUS-AGENTS.md`

---

## Environment configuration to introduce

Use explicit env vars with safe defaults:

- `MCP4_AGENT_ARTIFACT_SIGNING_KEY`
  - shared HMAC secret for artifact emission + verification
  - required for signing; required for strict trusted verification unless compatibility mode is enabled
- `MCP4_AGENT_ARTIFACT_KEY_ID`
  - default: `default`
  - included in signed envelope for future rotation
- `MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED`
  - `false` by default
  - when `true`, trusted parsing may accept legacy unsigned artifacts during migration only

Do **not** add an env var for algorithm in this first pass. Hard-code `hmac-sha256` to keep scope narrow.

---

## Shared contracts to introduce first

### `src/automation/artifact-signing.ts`

Create these exported types first:

```ts
export type ArtifactSignatureAlgorithm = 'hmac-sha256';

export interface SignedArtifactEnvelope<TPayload> {
  readonly version: 1;
  readonly kind: 'review-follow-up';
  readonly algorithm: ArtifactSignatureAlgorithm;
  readonly keyId: string;
  readonly payload: TPayload;
  readonly signature: string;
}

export interface ArtifactSigningConfig {
  readonly key: string;
  readonly keyId: string;
}

export type ArtifactVerificationResult<TPayload> =
  | { readonly ok: true; readonly envelope: SignedArtifactEnvelope<TPayload> }
  | { readonly ok: false; readonly reason: 'missing-signature' | 'invalid-signature' | 'unknown-format' | 'unsupported-version' | 'unsupported-algorithm' | 'missing-key' };
```

Export functions:

```ts
export function signArtifactEnvelope<TPayload extends object>(input: {
  readonly kind: 'review-follow-up';
  readonly payload: TPayload;
  readonly config: ArtifactSigningConfig;
}): SignedArtifactEnvelope<TPayload>;

export function verifyArtifactEnvelope<TPayload extends object>(input: {
  readonly envelope: unknown;
  readonly expectedKind: 'review-follow-up';
  readonly key: string | undefined;
}): ArtifactVerificationResult<TPayload>;
```

### `src/automation/artifact-signing-config.ts`

Create these exported types first:

```ts
export interface ArtifactTrustConfig {
  readonly signing?: {
    readonly key: string;
    readonly keyId: string;
  };
  readonly allowUnsigned: boolean;
}

export function readArtifactTrustConfig(env: NodeJS.ProcessEnv): ArtifactTrustConfig;
```

Behavior:
- no key + `allowUnsigned=false` is allowed for runners that only read leniently, but trusted execution paths must fail closed when a signed artifact is required and no key is configured
- blank strings count as missing values
- invalid boolean env values should throw `ConfigurationError`

### `src/automation/planner-artifact.ts`

Keep `ReviewFixPlanArtifact` as the canonical payload type, but add a parser split:

```ts
export interface ParseTrustedPlannerArtifactOptions {
  readonly trustConfig: ArtifactTrustConfig;
}

export function serializePlannerArtifact(
  artifact: ReviewFixPlanArtifact,
  options?: { readonly signing?: ArtifactSigningConfig }
): string;

export function parsePlannerArtifact(body: string): ReviewFixPlanArtifact | undefined;

export function parseTrustedPlannerArtifact(
  body: string,
  options: ParseTrustedPlannerArtifactOptions,
): ReviewFixPlanArtifact | undefined;
```

Rules:
- `parsePlannerArtifact(...)` remains lenient and usable for dedupe/debugging; it may accept both signed and legacy unsigned formats
- `parseTrustedPlannerArtifact(...)` verifies signature when envelope is signed
- unsigned legacy artifacts are rejected on trusted paths unless `allowUnsigned=true`
- invalid/tampered signed artifacts must not silently downgrade to unsigned acceptance

---

## Signed envelope format

Embed this JSON inside the existing HTML comment fence:

```json
{
  "version": 1,
  "kind": "review-follow-up",
  "algorithm": "hmac-sha256",
  "keyId": "default",
  "payload": {
    "kind": "review-follow-up",
    "threadId": "thread-1",
    "sourceCommentId": "comment-2",
    "headSha": "abc123",
    "fixSummary": "Update reply target handling",
    "implementationSteps": ["..."],
    "testSteps": ["..."],
    "verificationSteps": ["..."]
  },
  "signature": "base64url-or-hex"
}
```

Canonicalization rule for signing:
- sign exactly `JSON.stringify({ version, kind, algorithm, keyId, payload })`
- do not include `signature` in the signed bytes
- use UTF-8 and HMAC-SHA256

This keeps verification deterministic and easy to test.

---

## Trust boundary for this pass

### Lenient / read-only paths
These may use `parsePlannerArtifact(...)` and must never trigger execution just because parsing succeeded:
- planner duplicate detection in `src/automation/planner-runner.ts`
- local debugging / reporting paths
- human-readable issue comment rendering

### Trusted / execution paths
These must use `parseTrustedPlannerArtifact(...)` and fail closed on invalid trust:
- `parseImplementorTaskPayload(...)` in `src/automation/implementor-runner.ts`
- any planner -> implementor handoff path that turns comment text into executable follow-up work
- `scripts/run-implementor.ts` when extracting planner artifacts from issue comments

### Explicit non-goal in this pass
- merge gating should continue to rely on reply metadata and thread state, not planner artifact trust decisions, unless implementation discovers an existing trusted artifact dependency there

---

## Task plan

### Task 1: Add failing tests for signing primitives

**Objective:** Lock the signed-envelope behavior before wiring it into runners.

**Files:**
- Create: `src/automation/artifact-signing.test.ts`
- Reference: `src/automation/planner-artifact.ts`

**Step 1: Write failing unit tests for envelope signing**

Add tests for:
- successful sign + verify round-trip
- invalid signature after tampering with payload
- missing signature field
- unsupported `version`
- unsupported `algorithm`
- verification failure when key is missing

**Step 2: Run the focused tests to confirm failure**

Run:
```bash
npm run test:unit -- src/automation/artifact-signing.test.ts
```

Expected: FAIL because module does not exist yet.

**Step 3: Implement `src/automation/artifact-signing.ts` minimally**

Use `node:crypto` HMAC and deterministic JSON serialization.

**Step 4: Re-run tests**

Run:
```bash
npm run test:unit -- src/automation/artifact-signing.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/automation/artifact-signing.ts src/automation/artifact-signing.test.ts
git commit -m "feat(automation): add signed artifact primitives"
```

---

### Task 2: Add failing tests for env trust config

**Objective:** Define safe configuration parsing before runners consume it.

**Files:**
- Create: `src/automation/artifact-signing-config.ts`
- Create: `src/automation/artifact-signing-config.test.ts`
- Reference: `src/core/errors.ts`
- Reference: `src/tool-filter/config/env-config-parser.ts`

**Step 1: Write failing tests**

Cover:
- default config: `allowUnsigned=false`, no signing block when env is empty
- parses `MCP4_AGENT_ARTIFACT_SIGNING_KEY`
- trims / ignores blank `MCP4_AGENT_ARTIFACT_KEY_ID` and defaults to `default`
- parses `MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED=true|false`
- invalid boolean throws `ConfigurationError`

**Step 2: Run the focused tests to confirm failure**

Run:
```bash
npm run test:unit -- src/automation/artifact-signing-config.test.ts
```

**Step 3: Implement `readArtifactTrustConfig(env)`**

Use explicit boolean parsing; do not silently accept arbitrary strings.

**Step 4: Re-run tests**

Run:
```bash
npm run test:unit -- src/automation/artifact-signing-config.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/automation/artifact-signing-config.ts src/automation/artifact-signing-config.test.ts
git commit -m "feat(automation): add artifact trust config parsing"
```

---

### Task 3: Upgrade planner artifact serialization/parsing with trusted split

**Objective:** Keep the current artifact payload contract while adding signed-envelope support and a trusted parsing API.

**Files:**
- Modify: `src/automation/planner-artifact.ts`
- Modify: `src/automation/planner-artifact.test.ts`
- Reference: `src/automation/artifact-signing.ts`
- Reference: `src/automation/artifact-signing-config.ts`

**Step 1: Extend tests first**

Add coverage for:
- signed artifact round-trip through `serializePlannerArtifact(..., { signing })` + `parseTrustedPlannerArtifact(...)`
- legacy unsigned artifact accepted by `parsePlannerArtifact(...)`
- legacy unsigned artifact rejected by `parseTrustedPlannerArtifact(...)` when `allowUnsigned=false`
- legacy unsigned artifact accepted by `parseTrustedPlannerArtifact(...)` when `allowUnsigned=true`
- tampered signed artifact rejected on trusted parse
- malformed signed envelope rejected on trusted parse
- `parsePlannerArtifact(...)` still returns `undefined` for unrelated bodies

**Step 2: Run tests to confirm failure**

Run:
```bash
npm run test:unit -- src/automation/planner-artifact.test.ts
```

**Step 3: Implement trusted parser split**

Implementation notes:
- keep `validatePlannerArtifact(...)` for canonical payload validation
- add internal helpers:
  - extract raw JSON block from comment
  - detect legacy payload vs signed envelope
  - parse trusted envelope with verification
- do not let a failed signature silently fall back to unsigned acceptance when the body is clearly a signed envelope

**Step 4: Re-run tests**

Run:
```bash
npm run test:unit -- src/automation/planner-artifact.test.ts src/automation/artifact-signing.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/automation/planner-artifact.ts src/automation/planner-artifact.test.ts
git commit -m "feat(automation): add trusted planner artifact parsing"
```

---

### Task 4: Wire planner emission to sign artifacts when configured

**Objective:** Ensure planner-produced artifact comments are signed on emission without breaking pure planning behavior.

**Files:**
- Modify: `src/automation/planner-runner.ts`
- Modify: `src/automation/planner-runner.test.ts`
- Modify: `scripts/run-planner.ts`
- Modify: `docs/AUTONOMOUS-AGENTS.md`

**Step 1: Add failing tests in `planner-runner.test.ts`**

Cover:
- planner comment includes signed envelope when signing config is passed
- planner comment still renders without artifact when no planner artifact exists
- duplicate detection still ignores malformed artifact blocks without crashing
- duplicate detection remains based on parsed payload equality, not raw signature bytes

**Step 2: Run tests to confirm failure**

Run:
```bash
npm run test:unit -- src/automation/planner-runner.test.ts
```

**Step 3: Implement planner wiring**

Recommended shape:
- extend `CollectPlannerAssignmentsInput` / `buildPlannerDecisionComment(...)` with optional `artifactSigning?: ArtifactSigningConfig`
- in `scripts/run-planner.ts`, call `readArtifactTrustConfig(process.env)` once
- pass `trustConfig.signing` to planner comment rendering
- keep duplicate detection on `parsePlannerArtifact(...)` so signatures/key rotation do not create false duplicates for identical payloads

**Step 4: Re-run tests**

Run:
```bash
npm run test:unit -- src/automation/planner-runner.test.ts src/automation/planner-artifact.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/automation/planner-runner.ts src/automation/planner-runner.test.ts scripts/run-planner.ts
git commit -m "feat(automation): sign planner artifact comments"
```

---

### Task 5: Enforce trusted parsing in implementor workflow

**Objective:** Prevent unsigned or forged artifacts from driving implementor execution.

**Files:**
- Modify: `src/automation/implementor-runner.ts`
- Modify: `src/automation/implementor-runner.test.ts`
- Modify: `src/automation/implementor-codex.ts`
- Modify: `src/automation/implementor-codex.test.ts`
- Modify: `scripts/run-implementor.ts`
- Modify: `scripts/run-implementor-codex.ts`

**Step 1: Add failing tests in `implementor-runner.test.ts`**

Cover:
- trusted signed artifact is accepted and produces parsed `plannerArtifact`
- unsigned artifact is rejected when `allowUnsigned=false`
- unsigned artifact is accepted when `allowUnsigned=true`
- tampered signed artifact is rejected
- signed envelope with missing key is rejected on trusted path
- `plannerArtifact requires reviewFollowUpItems` still holds after trusted parsing

**Step 2: Add failing Codex wrapper tests**

Cover:
- Codex wrapper forwards trusted parsing errors with backend-specific wording
- valid signed payload still appears in the generated prompt as canonical payload JSON

**Step 3: Run focused tests to confirm failure**

Run:
```bash
npm run test:unit -- src/automation/implementor-runner.test.ts src/automation/implementor-codex.test.ts
```

**Step 4: Implement trusted consumption**

Implementation notes:
- extend `parseImplementorTaskPayload(raw, options?)` to accept `trustConfig`
- when `candidate.plannerArtifact` is a string, parse with `parseTrustedPlannerArtifact(...)`
- in `scripts/run-implementor.ts`, read trust config once, then use `parseTrustedPlannerArtifact(comment.body, { trustConfig })` when scanning issue comments
- in `scripts/run-implementor-codex.ts`, pass `readArtifactTrustConfig(process.env)` into `parseImplementorTaskPayload(...)`
- emit precise errors for trust failures; preferred message family:
  - `plannerArtifact must be signed or explicitly allowed unsigned`
  - `plannerArtifact signature verification failed`
  - `plannerArtifact signing key is not configured`

**Step 5: Re-run tests**

Run:
```bash
npm run test:unit -- src/automation/implementor-runner.test.ts src/automation/implementor-codex.test.ts src/automation/planner-artifact.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/automation/implementor-runner.ts src/automation/implementor-runner.test.ts src/automation/implementor-codex.ts src/automation/implementor-codex.test.ts scripts/run-implementor.ts scripts/run-implementor-codex.ts
git commit -m "feat(automation): verify trusted artifacts before implementor execution"
```

---

### Task 6: Document trust boundary and rollout behavior

**Objective:** Make the operational and security behavior explicit for future agents and humans.

**Files:**
- Modify: `docs/AUTONOMOUS-AGENTS.md`

**Step 1: Update docs**

Add a short subsection under review follow-up / planner handoff covering:
- planner artifacts may be signed
- execution paths must trust only verified artifacts
- unsigned artifacts are treated as untrusted text unless compatibility mode is enabled
- config vars and defaults
- key rotation note: rotate by changing secret and optionally `keyId`; historical unsigned/signed comments are read leniently only on non-execution paths

**Step 2: Verify docs are aligned with implementation**

Run:
```bash
npm run test:unit -- src/automation/planner-runner.test.ts src/automation/implementor-runner.test.ts src/automation/planner-artifact.test.ts
```

**Step 3: Commit**

```bash
git add docs/AUTONOMOUS-AGENTS.md
git commit -m "docs: document trusted agent artifact verification"
```

---

### Task 7: Run full targeted verification before opening PR

**Objective:** Confirm the hardening pass works end-to-end and does not regress the existing review-follow-up loop.

**Files:**
- No new files

**Step 1: Run all targeted unit tests**

Run:
```bash
npm run test:unit -- \
  src/automation/artifact-signing.test.ts \
  src/automation/artifact-signing-config.test.ts \
  src/automation/planner-artifact.test.ts \
  src/automation/planner-runner.test.ts \
  src/automation/implementor-runner.test.ts \
  src/automation/implementor-codex.test.ts
```

Expected: PASS

**Step 2: Run broader regression tests for the existing follow-up loop**

Run:
```bash
npm run test:unit -- \
  src/automation/reviewer-runner.test.ts \
  src/automation/merger-runner.test.ts \
  scripts/github-agent-runtime.test.ts
```

Expected: PASS

**Step 3: Run typecheck**

Run:
```bash
npm run typecheck
```

Expected: PASS

**Step 4: Prepare PR summary**

Mention explicitly that the PR is agent-authored and that the hardening scope is limited to planner/review-follow-up artifacts.

---

## Implementation notes / guardrails

- Prefer helper functions and named types over inline unions in runner code.
- Do not duplicate HMAC logic in both planner and implementor paths; centralize it in `artifact-signing.ts`.
- Do not let trusted parsing depend on GitHub author identity; this pass is about artifact authenticity, not commenter identity.
- Keep `parsePlannerArtifact(...)` usable for dedupe even when historical comments predate signing.
- Treat any invalid signed envelope as suspicious and fail closed on trusted paths.
- Do not read `.env` files directly while implementing or verifying this plan.

## Suggested PR breakdown

### PR 1
- `artifact-signing.ts`
- `artifact-signing-config.ts`
- `planner-artifact.ts`
- associated unit tests

### PR 2
- planner emission wiring
- implementor trusted parsing enforcement
- Codex wrapper updates
- associated workflow tests

### PR 3
- docs / cleanup / any compatibility rollout adjustments

## Ready-to-use PR title

```text
feat(automation): verify signed planner artifacts before follow-up execution
```

## Ready-to-use PR body checklist

- [ ] Signed artifact envelope added for planner/review-follow-up handoff
- [ ] Trusted parsing enforced on implementor execution paths
- [ ] Unsigned compatibility is explicit and off by default
- [ ] Unit + workflow regression tests added
- [ ] `npm run typecheck` passed
