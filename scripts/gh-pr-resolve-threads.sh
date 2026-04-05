#!/usr/bin/env bash
# Usage: gh-pr-resolve-threads.sh <owner/repo> <pr-number> [thread-id ...]
#
# Without thread IDs: resolves all open threads where the repo owner has replied
# (i.e. threads that have been addressed but not yet marked resolved).
# Thread list is fully paginated; fetches up to 100 comments per thread.
#
# With explicit thread IDs: resolves exactly those threads.
set -euo pipefail

REPO="${1:?Usage: $0 <owner/repo> <pr-number> [thread-id ...]}"
PR="${2:?Usage: $0 <owner/repo> <pr-number> [thread-id ...]}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
shift 2
EXPLICIT_IDS=("$@")

resolve_thread() {
  local thread_id="$1"
  local result
  result=$(gh api graphql -f query="
    mutation {
      resolveReviewThread(input: { threadId: \"$thread_id\" }) {
        thread { id isResolved }
      }
    }")
  local is_resolved
  is_resolved=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['resolveReviewThread']['thread']['isResolved'])")
  echo "  $thread_id -> resolved=$is_resolved"
}

if [ ${#EXPLICIT_IDS[@]} -gt 0 ]; then
  echo "Resolving ${#EXPLICIT_IDS[@]} explicit thread(s)..."
  for id in "${EXPLICIT_IDS[@]}"; do
    resolve_thread "$id"
  done
else
  echo "Auto-detecting open threads with owner reply..."

  IDS_TO_RESOLVE=$(OWNER="$OWNER" NAME="$NAME" PR="$PR" python3 << 'PYEOF'
import subprocess, json, os

owner = os.environ['OWNER']
name  = os.environ['NAME']
pr    = os.environ['PR']

def fetch_page(cursor=None):
    after = f', after: "{cursor}"' if cursor else ''
    query = """{
  repository(owner: "%s", name: "%s") {
    pullRequest(number: %s) {
      reviewThreads(first: 100%s) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes { author { login } }
          }
        }
      }
    }
  }
}""" % (owner, name, pr, after)
    result = subprocess.run(
        ['gh', 'api', 'graphql', '-f', f'query={query}'],
        capture_output=True, text=True, check=True
    )
    return json.loads(result.stdout)['data']['repository']['pullRequest']['reviewThreads']

all_threads = []
cursor = None
while True:
    page = fetch_page(cursor)
    all_threads.extend(page['nodes'])
    if not page['pageInfo']['hasNextPage']:
        break
    cursor = page['pageInfo']['endCursor']

for t in all_threads:
    if t['isResolved']:
        continue
    authors = [c['author']['login'] for c in t['comments']['nodes']]
    # Resolve if owner has replied (not just as original poster)
    if owner in authors[1:]:
        print(t['id'])
PYEOF
)

  if [ -z "$IDS_TO_RESOLVE" ]; then
    echo "No open threads with owner reply found."
    exit 0
  fi

  count=$(echo "$IDS_TO_RESOLVE" | wc -l | tr -d ' ')
  echo "Resolving $count thread(s)..."
  while IFS= read -r tid; do
    resolve_thread "$tid"
  done <<< "$IDS_TO_RESOLVE"
fi

echo "Done."
