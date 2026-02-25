#!/usr/bin/env bash
set -euo pipefail

PART="${1:-patch}"

case "$PART" in
  patch|minor|major) ;;
  *)
    echo "Error: version part must be one of: patch, minor, major" >&2
    exit 1
    ;;
esac

if [[ ! -f package.json ]]; then
  echo "Error: package.json not found in current directory" >&2
  exit 1
fi

if [[ ! -f CHANGELOG.md ]]; then
  echo "Error: CHANGELOG.md not found in current directory" >&2
  exit 1
fi

CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [[ -z "$CURRENT_VERSION" ]]; then
  echo "Error: cannot read version from package.json" >&2
  exit 1
fi

TARGET_VERSION="$(node -e '
const [v, part] = process.argv.slice(1);
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
if (!m) {
  console.error("Invalid semver in package.json:", v);
  process.exit(1);
}
let [major, minor, patch] = m.slice(1).map(Number);
if (part === "patch") patch += 1;
if (part === "minor") { minor += 1; patch = 0; }
if (part === "major") { major += 1; minor = 0; patch = 0; }
process.stdout.write(`${major}.${minor}.${patch}`);
' "$CURRENT_VERSION" "$PART")"

if grep -Fq "## [$TARGET_VERSION] - " CHANGELOG.md; then
  echo "Error: CHANGELOG already contains heading for version $TARGET_VERSION" >&2
  exit 1
fi

TODAY="$(date +%F)"
NEW_HEADING="## [$TARGET_VERSION] - $TODAY"

if ! grep -Fq '## [Unreleased]' CHANGELOG.md; then
  echo "Error: CHANGELOG.md does not contain '## [Unreleased]'" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
awk -v heading="$NEW_HEADING" '
  BEGIN { inserted = 0 }
  {
    print
    if (!inserted && $0 == "## [Unreleased]") {
      print ""
      print heading
      print ""
      inserted = 1
    }
  }
  END {
    if (!inserted) {
      exit 2
    }
  }
' CHANGELOG.md > "$TMP_FILE"

mv "$TMP_FILE" CHANGELOG.md

echo "Current package version: $CURRENT_VERSION"
echo "Target version: $TARGET_VERSION"
echo "Inserted changelog heading: $NEW_HEADING"

echo "Running npm version $PART --no-git-tag-version"
npm version "$PART" --no-git-tag-version >/dev/null

FINAL_VERSION="$(node -p "require('./package.json').version")"
if [[ "$FINAL_VERSION" != "$TARGET_VERSION" ]]; then
  echo "Error: package.json version is $FINAL_VERSION but expected $TARGET_VERSION" >&2
  exit 1
fi

if ! grep -Fq "$NEW_HEADING" CHANGELOG.md; then
  echo "Error: expected changelog heading not found after update" >&2
  exit 1
fi

echo "Verification passed: package.json=$FINAL_VERSION and CHANGELOG includes '$NEW_HEADING'"
