---
name: prepare-release-publishing
description: Prepare patch/minor/major release publishing in this repository by inserting a dated version header under `## [Unreleased]` in `CHANGELOG.md`, bumping `package.json` with `npm version`, and verifying both files are consistent. Use when asked with prompts like "prepare patch publishing", "prepare minor release", or "prepare major publish".
---

# Release Publishing

Run this skill from repository root.

## Inputs
- Release part: `patch`, `minor`, or `major`.

## Procedure
1. Run `./.claude/skills/prepare-release-publishing/scripts/prepare-release-publishing.sh <patch|minor|major>`.
2. Confirm output reports:
- current version from `package.json`
- target version computed from `package.json`
- inserted `CHANGELOG` heading in format `## [x.y.z] - YYYY-MM-DD`
- successful `npm version <part> --no-git-tag-version`
- final consistency check passed

## Guardrails
- Derive next version only from `package.json`, never from `CHANGELOG.md`.
- Insert the release heading directly below `## [Unreleased]`.
- Keep existing `Unreleased` notes in place.
- Fail if `CHANGELOG.md` has no `## [Unreleased]` section.
- Fail if computed target version and final `package.json` version differ.
- Support `patch`, `minor`, and `major` only.

## Command examples
```bash
./.claude/skills/prepare-release-publishing/scripts/prepare-release-publishing.sh patch
./.claude/skills/prepare-release-publishing/scripts/prepare-release-publishing.sh minor
./.claude/skills/prepare-release-publishing/scripts/prepare-release-publishing.sh major
```
