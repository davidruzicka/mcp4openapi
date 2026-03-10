# MCP Apps Extension Full Support Plan

## Goal
- Add profile-driven, complete support for the MCP Apps extension in this repository without implementing it yet.
- Prefer a fuller capability set over a smaller MVP, even when it increases implementation complexity.
- Keep the design aligned with the existing config-driven architecture, schema synchronization rules, and layered test strategy.

## Status
- [x] Decisions reviewed interactively.
- [x] Plan documented in `plans/`.
- [ ] Implementation not started.

## Confirmed Decisions

### Architecture
- [x] Add explicit top-level `resources[]` to profiles.
- [x] Support both fixed resources and resource templates with URI variables.
- [x] Support both static resources and resource-backed API fetches where needed.
- [x] UI data may flow through both `tools/call` and `resources/read`, with explicit boundaries.
- [x] Apps metadata should be strongly typed with a limited `custom_meta` escape hatch.

### Code Quality
- [x] Centralize Apps normalization/validation in a dedicated module instead of scattering rules.
- [x] Support resource content primarily through `file_path`, with optional small `inline_text`.
- [x] Keep `ToolGenerator` focused on core tool schema; compose Apps descriptor metadata in a thin layer above it.
- [x] Reuse `ValidationError`, but standardize `details.path`, `details.code`, and `details.reference`.

### Tests
- [x] Use three layers of coverage: loader validation, descriptor generation, MCP request handling.
- [x] Add both success and failure coverage for every new validation rule.
- [x] Treat schema sync as part of Definition of Done.
- [x] Add HTTP integration coverage for `resources/list` and `resources/read`.

### Performance
- [x] Preload static resource file contents at profile/server initialization.
- [x] Build both fixed-resource and template-resource lookup indexes at initialization.
- [x] Enforce an `inline_text` size limit and push larger content to files.
- [x] No hot reload in the first version; content and template definitions are fixed for process lifetime.

## Scope

### In Scope for Full Support
- Profile-level `resources[]` definitions for fixed resources and template resources.
- Tool-level Apps metadata for wiring tools to UI resources and richer tool status metadata.
- MCP `resources/list`, `resources/templates/list`, `resources/read`, and completion support where exposed by the SDK/protocol surface used in the repo.
- Preloaded static text resources from either `file_path` or `inline_text`.
- Dynamic resources resolved through explicit runtime fetch strategies.
- Validation and schema synchronization for the new profile shape.
- Unit, integration, and HTTP transport tests.
- Documentation updates for profile authors.

### Out of Scope for First Full Iteration
- Hot reload or file watching.
- Arbitrary binary asset pipelines beyond clearly typed content handling.
- Unbounded custom runtime scripting inside profiles.

## Proposed Profile Model

Add to `src/types/profile.ts`:

```ts
export interface Profile {
  profile_name: string;
  profile_id?: string;
  profile_aliases?: string[];
  openapi_spec_path?: string;
  description?: string;
  tools: ToolDefinition[];
  prompts?: PromptDefinition[];
  resources?: ResourceDefinition[];
  interceptors?: InterceptorConfig;
  parameter_aliases?: Record<string, string[]>;
  resource_name?: string;
  resource_documentation?: string;
}

export interface ResourceDefinition {
  name: string;
  kind: 'static' | 'template';
  uri?: string;
  uri_template?: string;
  title?: string;
  description?: string;
  mime_type: string;
  file_path?: string;
  inline_text?: string;
  fetch?: ResourceFetchDefinition;
  completion?: ResourceCompletionDefinition;
  apps?: ResourceAppsDefinition;
}

export interface ResourceFetchDefinition {
  source: 'operation' | 'composite';
  operation?: string;
  composite_tool?: string;
  parameter_mapping?: Record<string, string>;
  result_path?: string;
  cache_ttl_seconds?: number;
}

export interface ResourceCompletionDefinition {
  variables: Record<string, ResourceCompletionVariableDefinition>;
}

export interface ResourceCompletionVariableDefinition {
  source: 'static' | 'operation' | 'composite_tool';
  values?: string[];
  operation?: string;
  composite_tool?: string;
  result_path?: string;
  label_path?: string;
  value_path?: string;
  parameter_mapping?: Record<string, string>;
}

export interface ResourceAppsDefinition {
  widget_description?: string;
  widget_prefers_border?: boolean;
  widget_csp?: {
    connect_domains?: string[];
    resource_domains?: string[];
  };
  custom_meta?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  operations?: Record<string, OperationDefinition>;
  composite?: boolean;
  steps?: CompositeStep[];
  partial_results?: boolean;
  parameters: Record<string, ParameterDefinition>;
  metadata_params?: string[];
  response_fields?: Record<string, string[]>;
  send_response_fields_as_param?: boolean;
  apps?: ToolAppsDefinition;
}

export interface ToolAppsDefinition {
  output_template_resource_uri?: string;
  widget_accessible?: boolean;
  tool_invocation_message?: {
    invoking?: string;
    invoked?: string;
  };
  invocation_text?: {
    invoking?: string;
    invoked?: string;
  };
  annotations?: Record<string, unknown>;
  custom_meta?: Record<string, unknown>;
}
```

Notes:
- `kind: 'static'` uses fixed `uri`.
- `kind: 'template'` uses `uri_template` and optional completion config.
- `fetch` enables resource-backed runtime resolution for dynamic Apps UIs.
- `completion` allows profile-defined value completion for template variables.
- `invocation_text` may later collapse into one canonical shape if Apps client expectations are tightened during implementation.

## Validation Rules

Implement structural validation through generated schemas and semantic validation in `src/profile/profile-loader.ts` plus a dedicated Apps normalization module.

### Resource Rules
- `resources[].name` must be unique within a profile.
- Fixed resource `uri` values must be unique within a profile.
- Template `uri_template` values must be unique within a profile.
- `kind: 'static'` requires exactly one of `file_path`, `inline_text`, or `fetch`.
- `kind: 'template'` requires `uri_template` and may use either static content sources or `fetch`.
- `inline_text` must be limited to a small bounded size. Initial recommendation: 16 KB.
- `file_path` must exist and be readable at load time.
- `mime_type` is required.
- First iteration should at minimum allow text-safe content types:
  - `text/*`
  - `application/json`
- `uri` must be syntactically valid for fixed resource identifiers.
- `uri_template` must be syntactically valid and parseable as a URI template.
- Template variables must be unique and syntactically safe.
- `fetch.source = operation` requires a valid OpenAPI operation reference.
- `fetch.source = composite` requires a valid composite tool reference.
- `fetch.parameter_mapping` may only reference declared URI template variables or explicitly supported runtime arguments.
- `result_path` must be syntactically valid and bounded.

### Tool Apps Rules
- `apps.output_template_resource_uri`, when provided, must reference an existing `resources[].uri`.
- `apps.invocation_text.invoking` and `apps.invocation_text.invoked` should be bounded in length. Initial recommendation: 80 chars max.
- `apps.custom_meta` must remain JSON-serializable.
- Tools that target template resources must declare how runtime arguments map into template variables when direct derivation is not possible.

### Completion Rules
- Every declared completion variable must map to a URI template variable.
- Static completion values must be unique and bounded.
- Operation-backed completion definitions must specify valid extraction paths.
- Composite-tool completion definitions must reference read-safe tools only, or an explicitly allowed subset.

### Security Rules
- Resource-backed fetches must use the existing interceptor/auth stack or an explicitly constrained read-only execution path.
- No arbitrary remote fetches outside profile-declared OpenAPI/composite boundaries.
- Completion fetches must be bounded by timeout, result size, and maximum number of suggestions.
- Resource content and metadata must remain serializable and safe for transport.

### Error Detail Conventions
- Use `ValidationError`.
- Standardize detail payload fields:
  - `path`
  - `code`
  - `reference`
  - optional `value`

Suggested `details.code` values:
- `apps_resource_duplicate_name`
- `apps_resource_duplicate_uri`
- `apps_resource_duplicate_uri_template`
- `apps_resource_content_conflict`
- `apps_resource_missing_content`
- `apps_resource_file_not_found`
- `apps_resource_invalid_mime_type`
- `apps_resource_invalid_uri_template`
- `apps_resource_invalid_fetch_reference`
- `apps_resource_invalid_completion_definition`
- `apps_tool_missing_resource_reference`
- `apps_tool_invalid_template_mapping`
- `apps_tool_invalid_invocation_text`

## Runtime Design

### New Internal Module
- Create a dedicated module, for example:
  - `src/profile/profile-apps.ts`
  - or `src/profile/apps-profile-model.ts`

Responsibilities:
- Normalize Apps-related profile data.
- Resolve and preload resource content.
- Build runtime lookup maps.
- Compile URI templates and completion definitions.
- Build safe runtime executors for fetch-backed resources and completions.
- Expose a clean runtime model to `MCPServer`.

Example runtime shape:

```ts
export interface LoadedProfileAppsModel {
  fixedResources: LoadedResource[];
  templateResources: LoadedTemplateResource[];
  resourcesByUri: Map<string, LoadedResource>;
  templateResourcesByName: Map<string, LoadedTemplateResource>;
  toolAppsByName: Map<string, LoadedToolAppsBinding>;
}

export interface LoadedResource {
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType: string;
  text: string;
  appsMeta?: Record<string, unknown>;
}

export interface LoadedTemplateResource {
  name: string;
  uriTemplate: string;
  mimeType: string;
  staticText?: string;
  fetchStrategy?: LoadedResourceFetchStrategy;
  completion?: LoadedResourceCompletion;
  appsMeta?: Record<string, unknown>;
}

export interface LoadedToolAppsBinding {
  outputTemplateResourceUri?: string;
  outputTemplateResourceName?: string;
  variableMapping?: Record<string, string>;
  meta: Record<string, unknown>;
}
```

### MCP Server Changes
- Extend the server to support:
  - `resources/list`
  - template resource listing where appropriate
  - `resources/read`
-  - resource completion where appropriate
- Reuse preloaded runtime state; do not read files per request.
- Keep O(1) lookups via `resourcesByUri`.
- Add template matching and variable extraction for template resources.
- Add safe execution path for fetch-backed resources and completions.
- Preserve current `tools/list` behavior, but enrich tool descriptors with Apps metadata via a thin composition layer.

### Tool Descriptor Composition
- Keep `ToolGenerator` responsible for:
  - tool name
  - description
  - input schema
  - argument validation
- Add a separate composer module, for example:
  - `src/tooling/tool-app-descriptor.ts`

Responsibilities:
- Take the base tool descriptor from `ToolGenerator`.
- Merge in Apps-specific descriptor metadata from `toolDef.apps`.
- Keep Apps-specific policy out of the generator core.
- Optionally inject validated annotations and normalized `_meta` payloads.

## MCP Surface Plan

### `tools/list`
- Preserve existing tool generation.
- Add Apps metadata only when configured.
- Do not change non-Apps profiles.

### `resources/list`
- Return declared fixed resources and declared templates in the protocol shape supported by the selected SDK layer.
- Preserve stable ordering for deterministic tests.

### `resources/read`
- Accept declared fixed resource URIs and concrete URIs matching template resources.
- Resolve static resources from preloaded content.
- Resolve dynamic resources through explicit fetch strategies.
- Fail deterministically for unknown or ambiguous resource URIs.

### Resource Completion
- Support completion for template variables where configured.
- Return deterministic, bounded completion results.
- Deny completion on variables without configured completion handlers.

## File-Level Change Plan

### Types and Schemas
- `src/types/profile.ts`
- `src/generated-schemas.ts` via `npm run generate-schemas`
- `profile-schema.json` via schema sync scripts

### Validation and Normalization
- `src/profile/profile-loader.ts`
- New module:
  - `src/profile/profile-apps.ts` or equivalent

### Tool Descriptor Composition
- `src/tooling/tool-generator.ts`
- New module:
  - `src/tooling/tool-app-descriptor.ts`

### MCP Runtime
- `src/mcp/mcp-server.ts`

### Potential Supporting Runtime Modules
- `src/mcp/resource-template-registry.ts`
- `src/mcp/resource-fetch-executor.ts`
- `src/mcp/resource-completion.ts`

### Tests
- `src/profile/profile-loader.test.ts`
- New targeted tests for Apps normalization/composition
- `src/mcp/mcp-server.test.ts`
- `src/testing/mcp-server-http.test.ts`

### Docs
- `docs/PROFILE-GUIDE.md`
- `README.md`
- `CHANGELOG.md` for implementation PR, not for this planning-only task

## Test Plan

### Loader Validation Tests
- Success: profile with `resources[]` and valid tool Apps reference loads correctly.
- Failure: duplicate resource names.
- Failure: duplicate resource URIs.
- Failure: duplicate resource URI templates.
- Failure: both `file_path` and `inline_text`.
- Failure: neither `file_path` nor `inline_text`.
- Failure: missing referenced resource URI from tool Apps metadata.
- Failure: oversized `inline_text`.
- Failure: disallowed `mime_type`.
- Failure: unreadable or missing `file_path`.
- Failure: invalid URI template.
- Failure: invalid fetch operation reference.
- Failure: invalid completion config.

### Descriptor Composition Tests
- Success: tool without Apps metadata remains unchanged.
- Success: tool with Apps metadata receives correct descriptor metadata.
- Success: tool targeting a template resource emits normalized metadata.
- Failure-safe behavior: absent Apps model does not break descriptor generation.

### MCP Server Tests
- `resources/list` returns declared resources.
- `resources/read` returns preloaded content.
- `resources/read` resolves template resources from concrete URIs.
- `resources/read` resolves fetch-backed resources through allowed execution path.
- `resources/read` rejects unknown URI.
- `resources/read` rejects ambiguous template matches.
- Completion returns bounded suggestions for configured variables.
- `tools/list` includes Apps metadata only when configured.

### HTTP Integration Tests
- `POST /mcp` with `resources/list`.
- `POST /mcp` with `resources/read`.
- Completion request coverage over HTTP transport if exposed by current server/request plumbing.
- At least one routed-profile HTTP test if resources are used with profile routing.

### Definition of Done Checks
- `npm run generate-schemas`
- `npm run check-schema-sync`
- `npm run typecheck`
- Targeted tests for loader, server, and HTTP transport

## Suggested Implementation Sequence

### Phase 1 - Type and schema expansion
- Update `src/types/profile.ts`.
- Run `npm run generate-schemas`.
- Run `npm run check-schema-sync`.
- Add initial loader tests for new fields to prove schema wiring.

### Phase 2 - Apps normalization and validation
- Add the dedicated Apps profile normalization module.
- Implement semantic validation, URI-template compilation, and preloading logic.
- Add success and failure tests for new validation rules.

### Phase 3 - Descriptor composition
- Add tool descriptor Apps composer.
- Keep `ToolGenerator` focused on core schema generation.
- Add descriptor tests.

### Phase 4 - Static resource handlers
- Add runtime storage for preloaded resources.
- Implement `resources/list`.
- Implement `resources/read`.
- Add in-process server tests.

### Phase 5 - Template resources and completion
- Add template registry and variable extraction.
- Implement completion handlers for configured variables.
- Add tests for template matching, ambiguity handling, and completion limits.

### Phase 6 - Fetch-backed resources
- Add resource fetch execution using explicit operation/composite bindings.
- Reuse auth/interceptor stack with read-safe constraints.
- Add tests for successful fetch-backed resource reads and failure guards.

### Phase 7 - HTTP transport verification
- Add HTTP integration tests for the new methods.
- Confirm that non-Apps profiles remain unaffected.

### Phase 8 - Documentation
- Update profile authoring docs with examples and guardrails.
- Add concise `CHANGELOG.md` entry in the implementation PR.

## Risks and Guardrails

### Risk: Silent schema drift
- Guardrail: always regenerate schemas and run sync verification before considering the feature complete.

### Risk: Duplicated validation logic
- Guardrail: centralize Apps normalization and cross-reference validation in a dedicated module.

### Risk: Runtime I/O surprises
- Guardrail: preload file-based resources at startup and fail fast, while keeping fetch-backed resources explicitly bounded.

### Risk: Template ambiguity and routing bugs
- Guardrail: compile templates once, detect conflicts at load time where possible, and reject ambiguous runtime matches deterministically.

### Risk: Security regression from fetch-backed resources
- Guardrail: limit resource-backed fetches to declared operations/composite bindings, reusing auth/interceptor protections and adding explicit time/result bounds.

### Risk: Scope and complexity explosion
- Guardrail: implement in phases with green tests after each phase even though the end state targets fuller support.

## Open Questions for Future Iterations
- Should non-text MIME types ever be supported broadly, and if yes, under what constraints?
- Should Apps resource metadata be typed more deeply once concrete client requirements are stable?
- Should routed-profile HTML indexes eventually surface Apps resource discovery?
- Should fetch-backed resources share cache policy with ordinary API read flows or use an Apps-specific cache layer?

## Recommended Future Commit Message
- `feat(profile): add full MCP Apps resource, template, and tool metadata support`
