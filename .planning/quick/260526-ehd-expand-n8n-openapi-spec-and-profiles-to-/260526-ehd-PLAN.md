---
quick_id: 260526-ehd
description: Expand n8n OpenAPI spec and profiles to full Public API coverage
date: 2026-05-26
status: planned
---

# Quick Task 260526-ehd: Expand n8n OpenAPI spec and profiles to full Public API coverage

## Goal

Replace `profiles/n8n/openapi.yaml` with the current upstream n8n Public API spec (pinned to latest tagged release), then expand both profiles to expose all newly available endpoints. Result: full Public API coverage with two well-scoped profiles, complete test coverage, and no guessed operation IDs.

## Context

Local spec is v1.1.1 (2442 lines, 42 operations) and lags significantly behind upstream. Confirmed missing resources: credentials list/get/test, execution stop, workflow archive/unarchive, data tables (CRUD + rows + columns), project folders, community packages, insights summary.

### Review decisions (locked)
- Spec: fetch from tagged release, not master
- Data tables: split into `manage_data_tables` (table+column schema) + `manage_data_table_rows` (rows)
- Insights: merge `summary` into existing `audit` tool (not a new tool)
- Parameter aliases: add `table_id→dataTableId`, `folder_id→folderId`, `column_id→columnId`
- Tests: happy-path + one missing-required-param failure test per new tool
- Bulk row params: add description warning (keep batches under 100 rows)
- `manage_folders`: add description telling callers to use `manage_projects:list` for projectId first

### OperationId extraction (CRITICAL)
The spec uses `x-eov-operation-id` (non-standard). Profiles reference these exact IDs.
**Do NOT guess operationIds.** After fetching upstream spec, extract all IDs:
```bash
grep "x-eov-operation-id" profiles/n8n/openapi.yaml | sed 's/.*x-eov-operation-id: //' | sort
```

Existing operationIds that MUST survive (referenced in current profiles):
`updateCredential`, `deleteCredential`, `getCredentialType`, `createCredential`,
`getExecution`, `deleteExecution`, `retryExecution`, `getExecutions`,
`createTag`, `getTags`, `getTag`, `updateTag`, `deleteTag`,
`createUser`, `getUsers`, `getUser`, `deleteUser`, `changeRole`,
`createWorkflow`, `getWorkflows`, `getWorkflow`, `updateWorkflow`, `deleteWorkflow`,
`getWorkflowVersion`, `activateWorkflow`, `deactivateWorkflow`, `getWorkflowTags`,
`updateWorkflowTags`, `transferWorkflow`,
`createVariable`, `getVariables`, `updateVariable`, `deleteVariable`,
`createProject`, `getProjects`, `deleteProject`, `updateProject`,
`addUsersToProject`, `deleteUserFromProject`, `changeUserRoleInProject`,
`pull`, `generateAudit`

---

## Tasks

### Task 1: Fetch and replace upstream OpenAPI spec

**Files:** `profiles/n8n/openapi.yaml`

**Action:**
1. Find latest n8n release tag:
   ```bash
   LATEST_TAG=$(curl -s https://api.github.com/repos/n8n-io/n8n/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
   echo "Latest tag: $LATEST_TAG"
   ```
2. Fetch upstream spec:
   ```bash
   curl -s "https://raw.githubusercontent.com/n8n-io/n8n/refs/tags/${LATEST_TAG}/packages/cli/src/public-api/v1/openapi.yml" \
     -o /tmp/n8n-upstream.yaml
   ```
3. Verify fetch succeeded (file exists, is valid YAML, contains new paths):
   ```bash
   wc -l /tmp/n8n-upstream.yaml
   grep -c "x-eov-operation-id" /tmp/n8n-upstream.yaml
   grep "/data-tables" /tmp/n8n-upstream.yaml | head -3
   grep "/folders" /tmp/n8n-upstream.yaml | head -3
   ```
4. Compatibility check — verify NO existing operationIds were removed:
   ```bash
   comm -23 \
     <(grep "x-eov-operation-id" profiles/n8n/openapi.yaml | sed 's/.*x-eov-operation-id: //' | sort) \
     <(grep "x-eov-operation-id" /tmp/n8n-upstream.yaml | sed 's/.*x-eov-operation-id: //' | sort)
   # Must be empty. If not, update profile references BEFORE swapping.
   ```
5. Add version comment and replace:
   ```bash
   echo "# n8n Public API spec — tag: $LATEST_TAG (fetched 2026-05-26)" | \
     cat - /tmp/n8n-upstream.yaml > profiles/n8n/openapi.yaml
   ```
6. Extract all operationIds for use in Tasks 2-4:
   ```bash
   grep "x-eov-operation-id" profiles/n8n/openapi.yaml | sed 's/.*x-eov-operation-id: //' | sort
   ```

**Verify:** `npm run validate -- profiles/n8n/openapi.yaml` passes. New paths visible: `/data-tables`, `/projects/{projectId}/folders`, `/credentials` GET.

**Done:** openapi.yaml replaced, validate passes, new resources present.

---

### Task 2: Update full profile (profile.json)

**Files:** `profiles/n8n/profile.json`

**Action:**

Read the current profile.json in full to understand exact structure before editing.

**A. Add parameter aliases** (top-level `parameter_aliases` block):
```json
"table_id": ["dataTableId"],
"folder_id": ["folderId"],
"column_id": ["columnId"]
```

**B. manage_credentials** — add 3 operations to existing `operations` map:
- `list` → operationId for GET /credentials (extract from spec)
- `get` → operationId for GET /credentials/{id}
- `test` → operationId for POST /credentials/{id}/test
- Add `list`, `get`, `test` to action enum in parameters
- `get` and `test` require `id` param (already in param set)
- `list` uses pagination: `limit`, `cursor`

**C. manage_executions** — add 4 operations:
- `stop` → operationId for POST /executions/{id}/stop (param: id)
- `stop_all` → operationId for POST /executions/stop
- `get_tags` → operationId for GET /executions/{id}/tags (param: id)
- `update_tags` → operationId for PUT /executions/{id}/tags (param: id, body: tags array)

**D. manage_workflows** — add 2 operations:
- `archive` → operationId for POST /workflows/{id}/archive (param: id)
- `unarchive` → operationId for POST /workflows/{id}/unarchive (param: id)

**E. audit tool** — add 1 operation:
- `insights_summary` → operationId for GET /insights/summary
- Update description: "Generate security audits and retrieve instance insights."

**F. New tool: manage_data_tables** (table + column schema):
```json
{
  "name": "manage_data_tables",
  "description": "Manage n8n data tables and their column schemas.",
  "metadata_params": ["action"],
  "operations": {
    "list":          "<operationId for GET /data-tables>",
    "create":        "<operationId for POST /data-tables>",
    "get":           "<operationId for GET /data-tables/{dataTableId}>",
    "update":        "<operationId for PUT /data-tables/{dataTableId}>",
    "delete":        "<operationId for DELETE /data-tables/{dataTableId}>",
    "list_columns":  "<operationId for GET /data-tables/{dataTableId}/columns>",
    "create_column": "<operationId for POST /data-tables/{dataTableId}/columns>",
    "get_column":    "<operationId for GET /data-tables/{dataTableId}/columns/{columnId}>",
    "update_column": "<operationId for PUT /data-tables/{dataTableId}/columns/{columnId}>",
    "delete_column": "<operationId for DELETE /data-tables/{dataTableId}/columns/{columnId}>"
  },
  "parameters": {
    "action": { "type": "string", "enum": ["list","create","get","update","delete","list_columns","create_column","get_column","update_column","delete_column"], "required": true },
    "dataTableId": { "type": "string", "description": "Data table ID (alias: table_id)" },
    "columnId": { "type": "string", "description": "Column ID (alias: column_id)" },
    "name": { "type": "string", "description": "Table or column name" }
  }
}
```
Fill in actual operationIds from Step 2 extraction. Add any additional params required by the spec.

**G. New tool: manage_data_table_rows**:
```json
{
  "name": "manage_data_table_rows",
  "description": "Read and write rows in n8n data tables.",
  "metadata_params": ["action"],
  "operations": {
    "list":   "<operationId for GET /data-tables/{dataTableId}/rows>",
    "create": "<operationId for POST /data-tables/{dataTableId}/rows>",
    "update": "<operationId for POST /data-tables/{dataTableId}/rows/update>",
    "upsert": "<operationId for POST /data-tables/{dataTableId}/rows/upsert>",
    "delete": "<operationId for POST /data-tables/{dataTableId}/rows/delete>"
  },
  "parameters": {
    "action":      { "type": "string", "enum": ["list","create","update","upsert","delete"], "required": true },
    "dataTableId": { "type": "string", "description": "Data table ID (alias: table_id)", "required": true },
    "rows":        { "type": "array",  "description": "Array of rows to process. n8n enforces no documented limit; keep batches under 100 rows for reliability." }
  }
}
```

**H. New tool: manage_folders**:
```json
{
  "name": "manage_folders",
  "description": "Manage workflow folders within a project. All operations require projectId — use manage_projects:list to discover available project IDs first.",
  "metadata_params": ["action"],
  "operations": {
    "list":   "<operationId for GET /projects/{projectId}/folders>",
    "create": "<operationId for POST /projects/{projectId}/folders>",
    "get":    "<operationId for GET /projects/{projectId}/folders/{folderId}>",
    "update": "<operationId for PUT /projects/{projectId}/folders/{folderId}>",
    "delete": "<operationId for DELETE /projects/{projectId}/folders/{folderId}>"
  },
  "parameters": {
    "action":    { "type": "string", "enum": ["list","create","get","update","delete"], "required": true },
    "projectId": { "type": "string", "description": "Project ID (required for all folder operations)", "required": true },
    "folderId":  { "type": "string", "description": "Folder ID (alias: folder_id) — required for get, update, delete" },
    "name":      { "type": "string", "description": "Folder name" }
  }
}
```

**I. New tool: manage_community_packages**:
```json
{
  "name": "manage_community_packages",
  "description": "List and manage installed n8n community packages.",
  "metadata_params": ["action"],
  "operations": {
    "list":   "<operationId for GET /community-packages>",
    "get":    "<operationId for GET /community-packages/{name}>",
    "delete": "<operationId for DELETE /community-packages/{name}>"
  },
  "parameters": {
    "action": { "type": "string", "enum": ["list","get","delete"], "required": true },
    "name":   { "type": "string", "description": "Community package name" }
  }
}
```

Note: Fill placeholders with actual `x-eov-operation-id` values extracted in Task 1 Step 6. If any endpoint has no `x-eov-operation-id`, use path-based notation: `method_/path` (e.g., `get_/data-tables`).

**Verify:** `npm run validate -- profiles/n8n/profile.json profiles/n8n/openapi.yaml` passes.

**Done:** All new tools/operations present, validate passes.

---

### Task 3: Update optimized profile (profile-optimized.json)

**Files:** `profiles/n8n/profile-optimized.json`

**Action:**

Read current profile-optimized.json in full before editing.

**retrieve_content tool** — add to existing operations:
- `list_credentials` → operationId for GET /credentials
- `get_credential` → operationId for GET /credentials/{id}
- `list_data_tables` → operationId for GET /data-tables
- `get_data_table` → operationId for GET /data-tables/{dataTableId}
- `list_data_table_rows` → operationId for GET /data-tables/{dataTableId}/rows
- `list_folders` → operationId for GET /projects/{projectId}/folders
- `get_insights_summary` → operationId for GET /insights/summary

Add corresponding params: `id` (already present), `dataTableId`, `projectId` (already present).

**run_n8n_operations tool** — add to existing operations:
- `stop_execution` → operationId for POST /executions/{id}/stop
- `archive_workflow` → operationId for POST /workflows/{id}/archive
- `unarchive_workflow` → operationId for POST /workflows/{id}/unarchive

Add to action enum in parameters.

**Verify:** `npm run validate -- profiles/n8n/profile-optimized.json profiles/n8n/openapi.yaml` passes.

**Done:** Optimized profile validated with new operations.

---

### Task 4: Update test files

**Files:** `profiles/n8n/profile.test.json`, `profiles/n8n/profile-optimized.test.json`

**Action:**

Read both test files to understand exact format before editing.

For each new tool/operation, add:
1. **Happy-path test** — success: true, mock returns valid response shape
2. **Failure test** — missing required param → success: false (one per new tool)

**Test format reference:**
```json
{
  "name": "manage_data_tables - list",
  "tool": "manage_data_tables",
  "arguments": { "action": "list" },
  "mocks": [
    {
      "operationId": "<exact-id-from-spec>",
      "response": { "body": { "data": [], "nextCursor": null } }
    }
  ],
  "expect": { "success": true }
}
```

**profile.test.json** — add tests for:
- `manage_credentials`: list (happy), get (happy), test (happy), missing-id failure
- `manage_executions`: stop (happy), stop_all (happy), get_tags (happy), missing-id failure
- `manage_workflows`: archive (happy), unarchive (happy)
- `audit`: insights_summary (happy)
- `manage_data_tables`: list (happy), get (happy), list_columns (happy), missing-dataTableId failure
- `manage_data_table_rows`: list (happy), create with rows array (happy), missing-dataTableId failure
- `manage_folders`: list (happy), missing-projectId failure
- `manage_community_packages`: list (happy), get (happy)

**profile-optimized.test.json** — add tests for:
- `retrieve_content`: list_credentials (happy), list_data_tables (happy), list_data_table_rows (happy), list_folders (happy), get_insights_summary (happy)
- `run_n8n_operations`: stop_execution (happy), archive_workflow (happy), unarchive_workflow (happy)

Use exact operationIds (same as used in profiles). Response shapes should match spec schemas.

**Verify:** `npm test -- -t "n8n"` passes — all existing AND new tests green.

**Done:** All tests pass.

---

### Task 5: Final validation and CHANGELOG

**Files:** `CHANGELOG.md`

**Action:**

1. Run full validation suite:
   ```bash
   npm run validate -- profiles/n8n/openapi.yaml
   npm run validate -- profiles/n8n/profile.json profiles/n8n/openapi.yaml
   npm run validate -- profiles/n8n/profile-optimized.json profiles/n8n/openapi.yaml
   npm run validate -- profiles/n8n/node-list-profile.json profiles/n8n/node-list-openapi.yaml
   npm run typecheck
   npm test -- -t "n8n"
   ```
2. Spot checks:
   ```bash
   grep -c "manage_data_tables\|manage_data_table_rows\|manage_folders\|manage_community_packages" profiles/n8n/profile.json
   grep -c "table_id\|folder_id\|column_id" profiles/n8n/profile.json
   grep -c "list_credentials\|stop_execution\|archive_workflow" profiles/n8n/profile-optimized.json
   ```
3. Add CHANGELOG entry under most recent `## [Unreleased]` or appropriate version section:
   ```
   - Expanded n8n OpenAPI spec and profiles to full Public API coverage: credentials list/get/test, execution stop/tags, workflow archive/unarchive, data tables (CRUD + rows + columns), project folders, community packages, and instance insights.
   ```

**Verify:** All validate/test/typecheck pass. CHANGELOG updated.

**Done:** All checks green, CHANGELOG updated.

---

## Skipped (out of scope)
- `/n8n-packages/export` — Beta, disabled by default (`N8N_PUBLIC_API_PACKAGES_ENABLED=true` required)
- `/discover` — no practical agent use case
- `manage_folders` write ops in optimized profile — keep optimized read-heavy
- Data table write ops in optimized profile — full profile only
