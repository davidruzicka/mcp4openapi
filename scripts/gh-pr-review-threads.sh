#!/usr/bin/env bash
# Usage: gh-pr-review-threads.sh <owner/repo> <pr-number> [--short]
# Lists all review threads (fully paginated) with their resolved status, thread ID, and comment bodies.
# Fetches up to 10 comments per thread. Pass --short to truncate bodies to 120 characters.
set -euo pipefail

REPO="${1:?Usage: $0 <owner/repo> <pr-number> [--short]}"
PR="${2:?Usage: $0 <owner/repo> <pr-number> [--short]}"
SHORT=false
for arg in "${@:3}"; do
  [[ "$arg" == "--short" ]] && SHORT=true
done
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

SHORT="$SHORT" OWNER="$OWNER" NAME="$NAME" PR="$PR" python3 << 'PYEOF'
import subprocess, json, os

owner = os.environ['OWNER']
name  = os.environ['NAME']
pr    = os.environ['PR']
short = os.environ.get('SHORT', 'false') == 'true'

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
          isOutdated
          comments(first: 10) {
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

unresolved = [t for t in all_threads if not t['isResolved']]
resolved   = [t for t in all_threads if t['isResolved']]

def fmt_body(body):
    if short:
        return '  ' + body.replace('\n', ' ')[:120]
    return '\n'.join('  ' + l for l in body.splitlines())

def fmt_thread(t):
    first = t['comments']['nodes'][0]
    status = 'RESOLVED' if t['isResolved'] else ('OUTDATED' if t['isOutdated'] else 'OPEN')
    replies = t['comments']['nodes'][1:]
    print(f'[{status}] {t["id"]}')
    print(f'  #{first["databaseId"]} @{first["author"]["login"]} {first["createdAt"][:10]}')
    print(fmt_body(first['body']))
    for reply in replies:
        print(f'  -- @{reply["author"]["login"]} {reply["createdAt"][:10]}:')
        print(fmt_body(reply['body']))
    print()

print(f'=== OPEN ({len(unresolved)}) ===')
for t in unresolved:
    fmt_thread(t)

print(f'=== RESOLVED ({len(resolved)}) ===')
for t in resolved:
    fmt_thread(t)
PYEOF
