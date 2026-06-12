## Plan: ServerInfo title from profile_name

Recommendation: use `profile_name` for `serverInfo.title`, because it is the human-readable profile label and matches what VS Code now prefers in the UI. Apply `MCP4_SERVERINFO_SUFFIX` to `serverInfo.title` when configured. `serverInfo.name` is out of scope for this change and should remain unchanged.

**Steps**
1. Map the current MCP identity generation in `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/mcp/mcp-server.ts` and identify the single place where `serverInfo.name`, `serverInfo.title`, and `version` are composed for the `initialize` response. As part of this step, confirm that adding optional `serverInfo.title` is accepted by the MCP spec/client path used here and audit existing tests for strict response-shape assumptions.
2. Introduce one small internal identity source or helper inside `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/mcp/mcp-server.ts` so the touched slice does not further duplicate `name` and `version` literals between the SDK server constructor and the `initialize` response. This step depends on step 1.
3. Confirm how the active profile is resolved in both routed and startup flows so `serverInfo.title` can always be built from the loaded profile's `profile_name`. Derive title from the already loaded profile on the `MCPServer` instance; do not widen HTTP profile context unless implementation proves it is strictly necessary. Preserve the existing fail-fast behavior when no usable profile is loaded instead of adding any fallback path. This step depends on step 1.
4. Make `MCPServer` own `MCP4_SERVERINFO_SUFFIX`: read it once during server initialization/startup, normalize empty values to "no suffix", and cache the resulting optional suffix on the server instance. Do not read the environment variable on every `initialize` request and do not add any extra title cache beyond the existing per-profile `MCPServer` cache in `MCPServerManager`. This step depends on steps 1-2.
5. Update `serverInfo` construction so that `serverInfo.title` is the active profile's `profile_name`, optionally extended by the cached `MCP4_SERVERINFO_SUFFIX`. Make the initialize response contract explicit with a small local named type or helper that includes optional `title`. Leave `serverInfo.name` unchanged. This step depends on steps 2-4.
6. Complete and verify profile behavior in both paths: HTTP multi-profile via `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/mcp/mcp-server-manager.ts` and the startup/stdio path via startup profile resolution. In HTTP multi-profile mode, each connection to `/profile/:profileId/mcp` must receive an `initialize` response with its own `serverInfo.title` based on the currently routed profile. Keep routed-profile/effective-ID checking as tests or implementation sanity checks only; do not expand runtime validation scope unless a real mismatch is discovered. This step depends on step 5.
7. Add and update tests for six scenarios: strengthening the existing `handleInitialize` test to assert `serverInfo.title`, cached suffix behavior for `serverInfo.title`, unchanged `serverInfo.name`, two different routed HTTP profiles returning different `serverInfo.title` values, preservation of the existing error path at the current initialization/config boundary when no usable profile name is available, and backward compatibility for existing tests that already assert `serverInfo.name`. This step depends on steps 5-6.
8. Update documentation and changelog: the initialize response in HTTP docs, the new environment variable description, the fact that this change does not alter the existing fail-fast behavior for unusable profiles, and the user-facing impact in the VS Code tool picker. Also update `env.example` with the new optional variable. This step depends on steps 5-7.

**Relevant files**
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/mcp/mcp-server.ts` - source of the `initialize` response and MCP identity
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/mcp/mcp-server-manager.ts` - HTTP multi-profile server creation and profile context propagation
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/profile/startup-profile.ts` - startup/stdio resolved profile context
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/profile/profile-resolver.ts` - effective profile ID fallback from `profile_id` to `profile_name`
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/mcp/mcp-server.test.ts` - primary tests for the `initialize` response
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/src/mcp/mcp-server-manager.test.ts` - tests for the multi-profile server creation path
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/env.example` - example environment variable documentation
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/docs/HTTP-TRANSPORT.md` - documented initialize response
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/README.md` - environment variable and user-facing behavior
- `/home/davidr/GitLab/AI-Adoption/mcp/mcp4openapi/CHANGELOG.md` - user-facing change record

**Verification**
1. The existing `handleInitialize` unit test is strengthened to confirm `serverInfo.title = profile_name` by default while independently validating that `serverInfo.name` remains unchanged.
2. A cached-suffix test confirms that `MCP4_SERVERINFO_SUFFIX` changes `serverInfo.title` as expected and is not re-read per request after server construction/initialization.
3. An HTTP multi-profile response test confirms that two routes, `/profile/<a>/mcp` and `/profile/<b>/mcp`, return different `serverInfo.title` values based on the specific profile.
4. A failure-path regression test confirms that the existing error behavior remains unchanged at the current initialization/config boundary when no usable profile is loaded or `profile_name` is empty.
5. Existing tests that assert `serverInfo.name` continue to pass unchanged.
6. Run targeted MCP tests and then `npm run typecheck`.

**Decisions**
- `profile_name` is the user-facing display value and belongs in `serverInfo.title`.
- `MCP4_SERVERINFO_SUFFIX` applies to `serverInfo.title`, not to `serverInfo.name`.
- In HTTP multi-profile mode, `serverInfo.title` is per-profile metadata, not a process-global value.
- `serverInfo.name` is out of scope for this change and should remain exactly as it is unless implementation proves a separate existing bug.
- The preferred implementation is to derive title from the already loaded profile on the `MCPServer` instance, not to widen HTTP profile context unless that turns out to be strictly necessary.
- When no usable `profile_name` exists, the existing error behavior should remain unchanged.
- `MCPServer` owns `MCP4_SERVERINFO_SUFFIX`; it should be read once during startup/initialization and cached.
- No new title cache should be added beyond the existing per-profile `MCPServer` cache in `MCPServerManager`.
- Routed-profile/effective-ID consistency should be covered by tests and implementation sanity checks, not by expanding runtime validation scope unless a concrete mismatch is found.
- Scope includes MCP initialize metadata, tests, docs, and changelog.
- Scope does not include changing the profile schema to make `profile_id` mandatory.

**Further Considerations**
1. If the title suffix is meant only for some deployments, keep it optional and process-wide through a single environment variable.
2. If VS Code later prefers only `title`, this change already targets the user-visible field directly.
3. If implementation discovers a spec-less or profile-less startup path, treat it as existing invalid configuration behavior and keep this change scoped to `serverInfo.title` only.
