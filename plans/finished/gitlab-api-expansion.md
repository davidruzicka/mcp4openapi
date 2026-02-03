# GitLab API Expansion Plan (Profiles + OpenAPI)

## Scope
- Expand GitLab OpenAPI + profiles to cover developer and CI/CD workflows for issues, merge requests, pipelines/jobs, repository, projects, labels/milestones, notes, and webhooks.

## Execution Plan

### Phase 1 - Baseline OpenAPI coverage
- [x] Add missing Issues global search and filters to `profiles/gitlab/openapi.yaml`.
- [x] Add Merge Requests reviewer/assignee endpoints to `profiles/gitlab/openapi.yaml`.
- [x] Add MR pipelines artifacts list/download endpoints to `profiles/gitlab/openapi.yaml`.
- [x] Add Pipelines/Jobs endpoints (list pipelines by ref, list jobs for pipeline, retry/cancel job, download job artifacts) to `profiles/gitlab/openapi.yaml`.
- [x] Add Repository endpoints (tree, create/update/delete file, compare refs, get commit by SHA) to `profiles/gitlab/openapi.yaml`.
- [x] Add Projects endpoints (members list, project variables CRUD) to `profiles/gitlab/openapi.yaml`.
- [x] Add Labels/Milestones list for group vs project to `profiles/gitlab/openapi.yaml`.
- [x] Add Notes endpoints for award emoji and threaded discussions, including resolve/unresolve, to `profiles/gitlab/openapi.yaml`.
- [x] Add Webhooks endpoints (list/create/update/delete project hooks) to `profiles/gitlab/openapi.yaml`.

### Phase 2 - Profile mapping (all GitLab profiles)
- [x] Map new Issues global search actions into all GitLab profiles in `profiles/gitlab/` (including optimized).
- [x] Map MR reviewer/assignee actions into all GitLab profiles in `profiles/gitlab/`.
- [x] Map MR pipelines artifacts list/download into all GitLab profiles in `profiles/gitlab/`.
- [x] Map Pipelines/Jobs actions into all GitLab profiles in `profiles/gitlab/`.
- [x] Map Repository actions into all GitLab profiles in `profiles/gitlab/`.
- [x] Map Projects members + variables actions into all GitLab profiles in `profiles/gitlab/`.
- [x] Map Labels/Milestones list actions into all GitLab profiles in `profiles/gitlab/`.
- [x] Map Notes award emoji + threaded discussion resolve/unresolve into all GitLab profiles in `profiles/gitlab/`.
- [x] Map Webhooks CRUD into all GitLab profiles in `profiles/gitlab/`.

### Phase 3 - Tests and validation (all GitLab profiles)
- [x] Add/extend profile tests for new actions in all GitLab profile test files in `profiles/gitlab/`.
- [x] Run `npm run validate` for affected profiles against `profiles/gitlab/openapi.yaml`.
- [x] Run `npm test`.

### Phase 4 - Docs and changelog
- [x] Update `CHANGELOG.md` Unreleased with a concise summary of added GitLab coverage.
