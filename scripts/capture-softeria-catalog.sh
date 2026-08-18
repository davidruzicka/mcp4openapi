#!/usr/bin/env bash
# Recapture the Softeria upstream tool catalog fixture for a new pinned version.
#
# Regenerates tests/profiles/softeria-sharepoint/upstream-catalog-<version>.fixture.json
# from a locally started @softeria/ms-365-mcp-server in read-only discovery mode.
# No tenant, credentials, or browser are required.
#
# The fixture's upstream_version is the single source of truth for the pin:
# src/profile/softeria-profile.test.ts asserts that the fixture file name, the
# fixture's capture_command, and profile.json's upstream_pin all agree with it,
# and that every upstream_mcp.tools.allow entry exists in the captured catalog.
#
# Re-pin procedure:
#   1. scripts/capture-softeria-catalog.sh <new-version>
#   2. delete the old upstream-catalog-*.fixture.json (exactly one may remain)
#   3. update upstream_pin.version in tests/profiles/softeria-sharepoint/profile.json
#   4. review the allow-list against the new catalog, then run
#      npx vitest run src/profile/softeria-profile.test.ts
#
# See docs/PROFILE-GUIDE.md "Validating the Softeria SharePoint tool catalog"
# for the manual variant of this capture and why --list-permissions is unusable.
#
# Usage: scripts/capture-softeria-catalog.sh <version>   (e.g. 0.136.0)
# Env:   PORT=39117 to override the local capture port.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:?usage: scripts/capture-softeria-catalog.sh <version> (e.g. 0.136.0)}"
PORT="${PORT:-39117}"
BASE="http://127.0.0.1:${PORT}/mcp"
PACKAGE="@softeria/ms-365-mcp-server"
FIXTURE="tests/profiles/softeria-sharepoint/upstream-catalog-${VERSION}.fixture.json"
CAPTURE_COMMAND="npx -y ${PACKAGE}@${VERSION} --read-only --org-mode --allow-unauthenticated-discovery --http 127.0.0.1:${PORT}"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# 1. Start the pinned server in read-only discovery mode.
#    Do not pass --enabled-tools: it would filter the catalog being observed.
echo "Starting ${PACKAGE}@${VERSION} on 127.0.0.1:${PORT} ..."
$CAPTURE_COMMAND >/dev/null 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  curl -s -o /dev/null "$BASE" && break
  sleep 1
done

# 2. Initialize an MCP session.
curl -sf -X POST "$BASE" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"catalog-capture","version":"1.0.0"}}}' \
  >/dev/null

# 3. List tools and extract sorted names (single page; the server returns no nextCursor).
TOOLS_JSON="$(curl -sf -X POST "$BASE" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-03-26' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | sed -n 's/^data: //p' | jq -c '[.result.tools[].name] | sort')"

# 4. Write the fixture; upstream_version is the version constant everything else pins to.
jq -n \
  --arg package "$PACKAGE" \
  --arg version "$VERSION" \
  --arg captured_at "$(date +%F)" \
  --arg capture_command "$CAPTURE_COMMAND" \
  --argjson tools "$TOOLS_JSON" \
  '{
    upstream_package: $package,
    upstream_version: $version,
    captured_at: $captured_at,
    capture_command: $capture_command,
    capture_procedure: "MCP initialize followed by tools/list over Streamable HTTP at POST /mcp; tool names taken from result.tools[].name (single page, no nextCursor).",
    note: "Read-only catalog of the pinned upstream version. Used by src/profile/softeria-profile.test.ts to assert every upstream_mcp.tools.allow entry exists upstream.",
    tool_count: ($tools | length),
    tools: $tools
  }' > "$FIXTURE"

echo "Wrote ${FIXTURE} ($(jq -r '.tool_count' "$FIXTURE") tools)."
echo "Next: remove any old upstream-catalog-*.fixture.json, set upstream_pin.version"
echo "in tests/profiles/softeria-sharepoint/profile.json to ${VERSION}, then run:"
echo "  npx vitest run src/profile/softeria-profile.test.ts"
