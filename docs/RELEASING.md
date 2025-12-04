# Release Process

This document explains how to release a new version of mcp4openapi.

## Overview

Releases are **fully automated** via GitHub Actions when you push a version tag. The CI workflow:

1. Runs all unit tests
2. Runs all E2E tests
3. Publishes to npmjs.org
4. Publishes to GitHub Packages
5. Builds and pushes multi-arch Docker images to Docker Hub and GitHub Container Registry

## Release Steps

### 1. Update CHANGELOG.md

Move items from `[Unreleased]` section to a new version section (example for latest `v0.2.3`):

```markdown
## [Unreleased]
<!-- Empty for next version -->

## [0.2.4] - 2025-12-04

### Added
- Feature description

### Changed
- Change description

### Fixed
- Fix description
```

Update comparison links at bottom:
```markdown
[Unreleased]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/davidruzicka/mcp4openapi/compare/v0.2.3...v0.2.4
```

### 2. Commit Changes

```bash
git add CHANGELOG.md
git commit -m "chore: release v0.2.4"
```

### 3. Update package.json Version

```bash
npm version patch  # 0.2.3 → 0.2.4
# or
npm version minor  # 0.2.3 → 0.3.0
# or
npm version major  # 0.2.3 → 1.0.0
```

This updates `package.json` and creates a git commit.

### 4. Create and Push Tag

```bash
git tag v0.2.4
git push origin main --tags
```

**Important**: Tag must start with `v` (e.g., `v0.2.4`, not `0.2.4`) to trigger CI publishing.

### 5. Monitor CI Workflow

1. Go to https://github.com/davidruzicka/mcp4openapi/actions
2. Check the workflow run triggered by your tag
3. Verify all jobs pass:
   - ✅ `test` - Unit tests with coverage
   - ✅ `e2e` - End-to-end tests
   - ✅ `publish-npm` - npm publishing
   - ✅ `publish-docker` - Docker image build and push

### 6. Verify Publishing

**npm packages:**
- npmjs.org: https://www.npmjs.com/package/mcp4openapi
- GitHub Packages: https://github.com/davidruzicka/mcp4openapi/pkgs/npm/mcp4openapi

**Docker images:**
- Docker Hub: https://hub.docker.com/r/davidruzicka/mcp4openapi
- GitHub Container Registry: https://github.com/davidruzicka/mcp4openapi/pkgs/container/mcp4openapi

Check that:
- Version matches your tag
- Both amd64 and arm64 platforms are listed
- `latest` tag is updated

### 7. Create GitHub Release (Optional)

1. Go to https://github.com/davidruzicka/mcp4openapi/releases/new
2. Select your tag (`v0.2.4`)
3. Title: `v0.2.4`
4. Description: Copy from CHANGELOG.md
5. Click **Publish release**

## Troubleshooting

### npm Publishing Failed

**Error**: `403 Forbidden` or `401 Unauthorized`

**Solution**: Verify OIDC Trusted Publisher is configured correctly:
1. Check repository name matches exactly
2. Check workflow name is `ci.yml`
3. Environment should be blank for tags

**Alternative**: If OIDC doesn't work, add `NPM_TOKEN` secret:
1. Create token at https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Add to GitHub secrets as `NPM_TOKEN`
3. Uncomment `NODE_AUTH_TOKEN` line in `.github/workflows/ci.yml`

### Docker Publishing Failed

**Error**: `denied: access forbidden`

**Solution**: Check Docker Hub secrets:
1. `DOCKERHUB_USERNAME` is correct
2. `DOCKERHUB_TOKEN` is valid (regenerate if needed at https://hub.docker.com/settings/security)

### Tests Failed

**Solution**: Don't release broken code!
1. Fix failing tests locally
2. Run `npm test` and `npm run test:e2e`
3. Commit fixes
4. Delete failed tag: `git tag -d v0.2.4 && git push origin :refs/tags/v0.2.4`
5. Recreate tag after fixes

## Version Numbering (Semantic Versioning)

Follow https://semver.org:

- **Patch** (0.2.3 → 0.2.4): Bug fixes, minor documentation updates
- **Minor** (0.2.3 → 0.3.0): New features, backwards compatible
- **Major** (0.2.3 → 1.0.0): Breaking changes, API changes

## Pre-release Versions

For testing before official release:

```bash
npm version prerelease --preid=beta  # 0.2.3 → 0.2.4-beta.0
git tag v0.2.4-beta.0
git push origin main --tags
```

**Note**: Pre-release tags (containing `-`) won't trigger automatic publishing. You can manually publish:

```bash
npm publish --tag beta
```

## Rollback

If a release is broken:

### Rollback npm

```bash
npm deprecate mcp4openapi@0.2.4 "Broken release, use 0.2.3"
```

### Rollback Docker

Delete tags from Docker Hub UI or retag `latest`:

```bash
docker pull davidruzicka/mcp4openapi:0.2.3
docker tag davidruzicka/mcp4openapi:0.2.3 davidruzicka/mcp4openapi:latest
docker push davidruzicka/mcp4openapi:latest
```

## Release Checklist

- [ ] All tests pass locally (`npm test && npm run test:e2e`)
- [ ] CHANGELOG.md updated with version and date
- [ ] package.json version bumped
- [ ] Git commit created
- [ ] Git tag created with `v` prefix
- [ ] Tag pushed to GitHub
- [ ] CI workflow passed (all jobs green)
- [ ] npm package published (check npmjs.org)
- [ ] Docker images published (check Docker Hub)
- [ ] GitHub release created (optional but recommended)
- [ ] Announcement posted (Twitter, Discord, etc.) - optional

## Automation Details

### Multi-arch Docker Build

Images are built for:
- `linux/amd64` (Intel/AMD 64-bit)
- `linux/arm64` (ARM 64-bit, Apple Silicon, AWS Graviton)

Uses Docker Buildx with GitHub Actions cache for fast rebuilds.

### npm Provenance

npm packages include **provenance statements** (supply chain security):
- Links package to source code commit
- Links package to GitHub Actions workflow
- Verifiable attestation of build environment

Users can verify with:
```bash
npm view mcp4openapi --json | jq .dist.attestations
```

### GitHub Packages

Publishes to `@davidruzicka/mcp4openapi` on GitHub Packages.

**Note**: GitHub Packages require authentication to install. For public distribution, use npmjs.org instead.

## Questions?

Open an issue or check:
- [CI workflow](./.github/workflows/ci.yml)
- [CONTRIBUTING.md](../CONTRIBUTING.md)
