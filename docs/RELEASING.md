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

Move items from `[Unreleased]` section to a new version section (example for next release `vX.Y.Z`):

```markdown
## [Unreleased]
<!-- Empty for next version -->

## [X.Y.Z] - YYYY-MM-DD

### Added
- Feature description

### Changed
- Change description

### Fixed
- Fix description
```

Update comparison links at bottom:
```markdown
[Unreleased]: https://github.com/davidruzicka/mcp4openapi/compare/vX.Y.Z...HEAD
[X.Y.Z]: https://github.com/davidruzicka/mcp4openapi/compare/vX.Y.(Z-1)...vX.Y.Z
```

### 2. Commit Changes

```bash
git add CHANGELOG.md
git commit -m "chore: release vX.Y.Z"
```

### 3. Update package.json Version

```bash
npm version patch  # X.Y.(Z-1) -> X.Y.Z
# or
npm version minor  # X.Y.Z -> X.(Y+1).0
# or
npm version major  # X.Y.Z -> (X+1).0.0
```

This updates `package.json` and creates a git commit.

### 4. Create and Push Tag

```bash
git tag vX.Y.Z
git push origin main --tags
```

**Important**: Tag must start with `v` (e.g., `vX.Y.Z`, not `X.Y.Z`) to trigger CI publishing.

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
2. Select your tag (`vX.Y.Z`)
3. Title: `vX.Y.Z`
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
4. Delete failed tag: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`
5. Recreate tag after fixes

## Version Numbering (Semantic Versioning)

Follow https://semver.org:

- **Patch** (X.Y.(Z-1) -> X.Y.Z): Bug fixes, minor documentation updates
- **Minor** (X.Y.Z -> X.(Y+1).0): New features, backwards compatible
- **Major** (X.Y.Z -> (X+1).0.0): Breaking changes, API changes

## Pre-release Versions

For testing before official release:

```bash
npm version prerelease --preid=beta  # X.Y.(Z-1) -> X.Y.Z-beta.0
git tag vX.Y.Z-beta.0
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
npm deprecate mcp4openapi@X.Y.Z "Broken release, use X.Y.(Z-1)"
```

### Rollback Docker

Delete tags from Docker Hub UI or retag `latest`:

```bash
docker pull davidruzicka/mcp4openapi:X.Y.(Z-1)
docker tag davidruzicka/mcp4openapi:X.Y.(Z-1) davidruzicka/mcp4openapi:latest
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
