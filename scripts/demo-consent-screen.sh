#!/usr/bin/env bash
# Demo: render the consent-gate screens locally, with no Entra/SharePoint access.
#
# Starts the gateway with the consent-gate test fixture profile (fake OAuth
# values) and opens two human-facing screens in the browser:
#   1. the informational consent page          /profile/consent-gate/consent
#   2. the approval form (accept-rules screen) /profile/consent-gate/oauth/authorize?...
#
# Submitting the approval form continues the OAuth flow to the fixture's fake
# Entra issuer and fails there - expected; the screens are what this demo shows.
#
# Usage: scripts/demo-consent-screen.sh   (Ctrl+C stops the server and cleans up)
# Env:   PORT=3399 to override the port.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3399}"
BASE="http://127.0.0.1:${PORT}"
EVIDENCE_DIR="$(mktemp -d)"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$EVIDENCE_DIR"
}
trap cleanup EXIT

if [ ! -f dist/src/index.js ]; then
  echo "Building (dist/ missing) ..."
  npm run build >/dev/null
fi

MCP4_TRANSPORT=http \
MCP4_HOST=127.0.0.1 \
MCP4_PORT="$PORT" \
MCP4_HTTP_PROFILE_ROUTING=true \
MCP4_PROFILES_DIR=./tests/profiles \
MCP4_ALLOW_PROFILES=consent-gate \
MCP4_OAUTH_KEY=local-demo-passphrase \
MCP4_CONSENT_EVIDENCE_PATH="$EVIDENCE_DIR/evidence.jsonl" \
node dist/src/index.js >"$EVIDENCE_DIR/server.log" 2>&1 &
SERVER_PID=$!

echo "Waiting for the gateway on $BASE ..."
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "$BASE/profile/consent-gate/consent"; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server failed to start:"; tail -20 "$EVIDENCE_DIR/server.log"; exit 1
  fi
  sleep 0.5
done

INFO_URL="$BASE/profile/consent-gate/consent"
# Any syntactically valid OAuth request renders the approval form; the
# pre-registered mcp-proxy-client and a localhost redirect keep it self-contained.
APPROVAL_URL="$BASE/profile/consent-gate/oauth/authorize?response_type=code&client_id=mcp-proxy-client&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=openid&state=demo&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"

echo
echo "Consent info page:      $INFO_URL"
echo "Consent approval form:  $APPROVAL_URL"
echo
echo "Submitting the approval form then fails at the fixture's fake Entra issuer - expected."
echo "Ctrl+C stops the server."

if command -v xdg-open >/dev/null; then OPEN=xdg-open;
elif command -v open >/dev/null; then OPEN=open;
else OPEN=""; fi
if [ -n "$OPEN" ]; then
  "$OPEN" "$INFO_URL" >/dev/null 2>&1 || true
  sleep 1
  "$OPEN" "$APPROVAL_URL" >/dev/null 2>&1 || true
fi

wait "$SERVER_PID"
