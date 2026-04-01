#!/usr/bin/env bash
# Usage: gh-pr-reply-thread.sh <owner/repo> <pr-number> <comment-id> [body]
#
# Posts a reply to an existing PR review comment.
# <comment-id> is the numeric databaseId shown by gh-pr-review-threads.sh.
# [body] is the reply text. If omitted, body is read from stdin.
#
# Example:
#   bash scripts/gh-pr-reply-thread.sh owner/repo 42 12345 "Fixed in abc123."
#   echo "Fixed." | bash scripts/gh-pr-reply-thread.sh owner/repo 42 12345
set -euo pipefail

REPO="${1:?Usage: $0 <owner/repo> <pr-number> <comment-id> [body]}"
PR="${2:?Usage: $0 <owner/repo> <pr-number> <comment-id> [body]}"
COMMENT_ID="${3:?Usage: $0 <owner/repo> <pr-number> <comment-id> [body]}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"

if [ $# -ge 4 ]; then
  BODY="${4}"
else
  BODY="$(cat)"
fi

RESULT=$(gh api "repos/${OWNER}/${NAME}/pulls/${PR}/comments/${COMMENT_ID}/replies" \
  -X POST \
  --input - <<< "{\"body\": $(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$BODY")}")

REPLY_ID=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['id'])")
echo "  replied -> comment_id=$REPLY_ID"
