#!/usr/bin/env bash
# Usage: gh-pr-review-threads.sh <owner/repo> <pr-number> [--short]
# Lists all review threads with their resolved status, thread ID, and comment bodies.
# Pass --short to truncate bodies to 120 characters (default: full body).
set -euo pipefail

REPO="${1:?Usage: $0 <owner/repo> <pr-number> [--short]}"
PR="${2:?Usage: $0 <owner/repo> <pr-number> [--short]}"
SHORT=false
for arg in "${@:3}"; do
  [[ "$arg" == "--short" ]] && SHORT=true
done
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

GQL_RESULT=$(gh api graphql -f query="
{
  repository(owner: \"$OWNER\", name: \"$NAME\") {
    pullRequest(number: $PR) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first: 3) {
            nodes {
              databaseId
              author { login }
              createdAt
              body
            }
          }
        }
      }
    }
  }
}")

echo "$GQL_RESULT" | SHORT="$SHORT" python3 -c "
import sys, json, os, textwrap

data = json.load(sys.stdin)
threads = data['data']['repository']['pullRequest']['reviewThreads']['nodes']
short = os.environ.get('SHORT', 'false') == 'true'

unresolved = [t for t in threads if not t['isResolved']]
resolved   = [t for t in threads if t['isResolved']]

def fmt_body(body):
    if short:
        return '  ' + body.replace('\n', ' ')[:120]
    lines = body.splitlines()
    return '\n'.join('  ' + l for l in lines)

def fmt_thread(t):
    first = t['comments']['nodes'][0]
    status = 'RESOLVED' if t['isResolved'] else ('OUTDATED' if t['isOutdated'] else 'OPEN')
    replies = t['comments']['nodes'][1:]
    print(f'[{status}] {t[\"id\"]}')
    print(f'  #{first[\"databaseId\"]} @{first[\"author\"][\"login\"]} {first[\"createdAt\"][:10]}')
    print(fmt_body(first['body']))
    for reply in replies:
        print(f'  -- @{reply[\"author\"][\"login\"]} {reply[\"createdAt\"][:10]}:')
        print(fmt_body(reply['body']))
    print()

print(f'=== OPEN ({len(unresolved)}) ===')
for t in unresolved:
    fmt_thread(t)

print(f'=== RESOLVED ({len(resolved)}) ===')
for t in resolved:
    fmt_thread(t)
"
