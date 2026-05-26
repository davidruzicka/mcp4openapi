---
quick_id: 260526-ehd
description: Expand n8n OpenAPI spec and profiles to full Public API coverage
date: 2026-05-26
status: complete
tags: [n8n, profiles, openapi, data-tables, folders, community-packages, credentials]
key-files:
  modified:
    - profiles/n8n/openapi.yaml
    - profiles/n8n/profile.json
    - profiles/n8n/profile-optimized.json
    - profiles/n8n/profile.test.json
    - profiles/n8n/profile-optimized.test.json
    - CHANGELOG.md
decisions:
  - Used path-based notation (method_path) for operations without standard operationId in spec
  - Data table rows update/upsert use filter.filters structure per spec schema
  - manage_data_table_rows uses 'data' param name (API field) not 'rows'
  - Community packages install uses 'name' param (matches API field)
  - Removed get_column operation - no GET endpoint for individual column in spec
  - Community packages has no GET-single-package endpoint - removed from profile
metrics:
  duration: ~45min
  tasks: 5
  files: 6
---

# Quick Task 260526-ehd: Expand n8n OpenAPI spec and profiles to full Public API coverage

**One-liner:** Replaced n8n OpenAPI spec with bundled upstream n8n@2.21.7 (78 operations, was 42) and expanded both profiles to full Public API coverage with 139 passing tests.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Fetch and replace upstream OpenAPI spec | 23d3569 | openapi.yaml: 4657 lines, 78 operations (was 2441, 42 ops) |
| 2 | Update full profile (profile.json) | 0293105 | 13 tools, 76 operations; 4 new tools; new aliases |
| 3 | Update optimized profile (profile-optimized.json) | 39a59ec | 5 tools, 53 operations; 7 new retrieve ops, 3 new run ops |
| 4 | Update test files | 992d950 | 81 scenarios (profile), 53 scenarios (optimized); all pass |
| 5 | Final validation and CHANGELOG | eeda830 | CHANGELOG updated, all checks green |

## Changes by File

### profiles/n8n/openapi.yaml
- Replaced with bundled spec from `n8n@2.21.7` (fetched 2026-05-26)
- Used `@redocly/cli bundle` to resolve all `$ref` references from cloned repo
- 78 operations vs 42 previously (86% increase)
- Compatibility check: all 42 existing operationIds preserved

### profiles/n8n/profile.json (13 tools, 76 operations)
- New parameter aliases: `dataTableId->table_id`, `folderId->folder_id`, `columnId->column_id`
- `audit`: added `insights_summary` action (GET /insights/summary)
- `manage_credentials`: added `list`, `get`, `test` operations
- `manage_executions`: added `stop`, `stop_all`, `get_tags`, `update_tags` operations
- `manage_workflows`: added `archive`, `unarchive` operations
- New tool `manage_data_tables`: table CRUD + column schema management (9 actions)
- New tool `manage_data_table_rows`: row CRUD with filter-based update/upsert (5 actions)
- New tool `manage_folders`: folder CRUD within projects (5 actions)
- New tool `manage_community_packages`: package list/install/update/delete (4 actions)

### profiles/n8n/profile-optimized.json (5 tools, 53 operations)
- `retrieve_content`: added list_credentials, get_credential, list_data_tables, get_data_table, list_data_table_rows, list_folders, get_insights_summary
- `run_n8n_operations`: added stop_execution, archive_workflow, unarchive_workflow

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Path-based operationId notation required for most operations**
- **Found during:** Task 2 (profile validation)
- **Issue:** The plan specified using `x-eov-operation-id` values (camelCase) as operation references. The OpenAPI parser in this codebase uses the standard `operationId` field, not `x-eov-operation-id`. Most n8n operations lack a standard `operationId` (only credentials and data-tables have it).
- **Fix:** Used `method_path` notation (e.g., `post_/audit`) for operations without standard `operationId`; used standard `operationId` (kebab-case, e.g., `list-data-tables`) for data-table operations.
- **Files modified:** profile.json, profile-optimized.json, profile.test.json, profile-optimized.test.json

**2. [Rule 1 - Bug] Data table row API schema differs from plan**
- **Found during:** Task 4 (test execution)
- **Issue:** Plan used `rows` array param; actual API uses `data` for inserts and `filter.filters` + `data` for update/upsert.
- **Fix:** Updated profile parameter names and test scenarios to match API schema.
- **Files modified:** profile.json, profile.test.json

**3. [Rule 1 - Bug] No GET single endpoint for community-packages/{name} or data-table column**
- **Found during:** Task 2
- **Issue:** Plan included `get` action for community packages and `get_column` for data tables. Neither endpoint exists in the spec.
- **Fix:** Removed both non-existent operations.

**4. [Rule 1 - Bug] Community packages install uses 'name' not 'packageName'**
- **Found during:** Task 4
- **Issue:** Plan specified `packageName` param for install; API requires `name`.
- **Fix:** Unified to `name` param for all community package name references.

## Self-Check
