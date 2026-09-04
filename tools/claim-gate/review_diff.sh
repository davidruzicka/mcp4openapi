#!/bin/bash
# Pre-commit review of the change against the target branch.
#
# Hunts a class of defects tests do not catch, because the logic is fine but a claim
# about how the code is wired together is not: deleted merged work of others, an
# orphaned reference to a removed function, a conflict marker.

# git grep pathspecs and relative paths are cwd-relative, so a run from a subdirectory
# would scan only a fraction of the tree and look exactly like a clean run.
cd "$(git rev-parse --show-toplevel)" || exit 2

centered_text() {
    if [ -z "$CI" ]; then
      termwidth="$(tput cols 2>/dev/null || echo 80)";
    else
      termwidth=60;
    fi
    padding="$(printf '%0.1s' ={1..500})"
    printf '\e[1;34m'
    printf '%*.*s %s %*.*s\n' 0 "$(((termwidth - 2 - ${#1}) / 2))" "$padding" "$1" 0 "$(((termwidth - 1 - ${#1}) / 2))" "$padding"
    printf '\e[0m'
}

exit_code=0

# The target branch is the one this change will merge into; not every MR targets main.
resolve_target() {
    if git rev-parse --verify --quiet "origin/$1" >/dev/null; then
        echo "origin/$1"
    elif git rev-parse --verify --quiet "$1" >/dev/null; then
        echo "$1"
    else
        local similar
        similar=$(git for-each-ref --format='%(refname:short)' 'refs/heads/*' 'refs/remotes/origin/*' \
            | grep -iF "$1" | head -3 | tr '\n' ' ')
        echo "Branch '$1' does not exist, not even as origin/$1." >&2
        [ -n "$similar" ] && echo "Similar existing branches: $similar" >&2
        echo "If the branch is new, it may be missing locally: git fetch origin $1" >&2
        exit 2
    fi
}

# Every check below compares the merge base with the WORKING TREE, not with HEAD:
# the gate runs before a commit, so uncommitted work is exactly what it must see.
# The merge base (not the tip of the target branch) so that commits merged into the
# target after branching do not show up as removed lines.
merge_base_with() {
    git merge-base "$1" HEAD
}

show_net_diff() {
    centered_text "Change against $2"
    git diff --stat "$1"
    printf "\nReview the full change: git diff %s\n" "$1"
}

# A file the change only removes from is often deleted merged work of others, typically
# when the branch was created off an older base and overwrote what was already merged.
# Files with mixed additions and removals matter too; what decides is WHO wrote the
# removed lines, so each removed hunk is blamed at the merge base.
warn_on_pure_deletions() {
    local base="$1" me file ranges start count foreign total_foreign=0 report=''
    me=$(git config user.email)

    while read -r file; do
        [ -z "$file" ] && continue
        foreign=0
        # Old lines of removed hunks; -U0 emits hunks without context, so ranges are exact.
        ranges=$(git diff -U0 "$base" -- "$file" | sed -nE 's/^@@ -([0-9]+)(,([0-9]+))? .*/\1 \3/p')
        while read -r start count; do
            [ -z "$start" ] && continue
            count=${count:-1}
            [ "$count" -eq 0 ] && continue
            # --line-porcelain repeats the full header for EVERY line; plain
            # --porcelain emits it once per commit group and undercounts.
            foreign=$((foreign + $(git blame --line-porcelain -L "$start,+$count" "$base" -- "$file" 2>/dev/null \
                | grep -c '^author-mail ' || true)))
            foreign=$((foreign - $(git blame --line-porcelain -L "$start,+$count" "$base" -- "$file" 2>/dev/null \
                | grep -c "^author-mail <$me>" || true)))
        done <<< "$ranges"

        if [ "$foreign" -gt 0 ]; then
            report="$report  $file (-$foreign lines written by someone else)"$'\n'
            total_foreign=$((total_foreign + foreign))
        fi
    done <<< "$(git diff --numstat "$base" | awk '$2 != "0" && $2 != "-" { print $3 }')"

    if [ "$total_foreign" -gt 0 ]; then
        centered_text "You are deleting lines someone else wrote"
        printf '%s' "$report"
        echo
        echo "A warning, not an error - verify this is intended, not overwritten merged work."
        echo "Who wrote them and why: git log -p $1 -- <file>   /   git blame $1 -- <file>"
    fi
}

# A removed function with a call site left behind fails only at runtime.
SOURCE_PATHSPEC=('*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')

check_orphan_references() {
    local removed_names name hits
    # Covers `function name(` declarations (with export/async prefixes) and
    # `const name = (...) =>` / `const name = async (` style definitions.
    # Digits and $ are legal in identifiers; a truncated name silently matches nothing.
    removed_names=$( { git diff "$1" -- "${SOURCE_PATHSPEC[@]}" \
        | grep -E '^-\s*(export\s+)?(async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*' \
        | sed -E 's/^-\s*(export\s+)?(async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*).*/\3/';
      git diff "$1" -- "${SOURCE_PATHSPEC[@]}" \
        | grep -E '^-\s*(export\s+)?(const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(async\s*)?(\(|function)' \
        | sed -E 's/^-\s*(export\s+)?(const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*).*/\3/'; } | sort -u)

    [ -z "$removed_names" ] && return

    local before after def_re
    for name in $removed_names; do
        # A definition existing elsewhere is not enough; common names repeat across
        # modules and the check would switch itself off. What decides is whether the
        # definition count dropped against the merge base.
        def_re="(function[[:space:]]+$name\b|(const|let)[[:space:]]+$name[[:space:]]*=)"
        before=$(git grep -cE "$def_re" "$1" -- "${SOURCE_PATHSPEC[@]}" 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
        after=$(git grep -cE "$def_re" -- "${SOURCE_PATHSPEC[@]}" 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')
        if [ "$after" -ge "$before" ]; then
            continue
        fi
        hits=$(git grep -nE "\b$name\(" -- "${SOURCE_PATHSPEC[@]}" | grep -vE "(function[[:space:]]+$name\b|(const|let)[[:space:]]+$name[[:space:]]*=|import[[:space:]{])")
        if [ -n "$hits" ]; then
            centered_text "Reference to removed function $name"
            echo "Definitions in the repo: $before before the change, $after after. Remaining call sites:"
            echo "$hits"
            echo
            echo "When renaming, update the call sites too; when moving, verify the callers"
            echo "resolve the new location. If this is a different function of the same name,"
            echo "ignore the report."
            exit_code=1
        fi
    done
}

check_conflict_markers() {
    local hits
    # A bare ======= is deliberately excluded; it is a common heading underline.
    # The extension list lives here once for both the local run and the CI job, which
    # calls this check via --check; two copies would diverge and then disagree.
    hits=$(git grep -nE '^(<{7} |>{7} |\|{7} )' -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.py' '*.html' '*.sql' '*.yml' '*.yaml')
    if [ -n "$hits" ]; then
        centered_text "Conflict markers in source files"
        echo "$hits"
        exit_code=1
    fi
}

# In a local run a missing checker or no instruction file is silently skipped; a branch
# may legitimately lack them. In CI a silent skip is the worst outcome: the job would
# turn green without checking anything, so --check mode fails loudly instead.
check_agents_claims() {
    local strict="$1"
    local checker='tools/claim-gate/check_agents_claims.py'
    if [ ! -f "$checker" ]; then
        [ "$strict" = 'strict' ] && { echo "Missing $checker, the check cannot run." >&2; exit 2; }
        return
    fi

    local docs
    docs=$(git ls-files 'AGENTS.md' '*/AGENTS.md' 'CLAUDE.md' 'IMPLEMENTATION.md')
    if [ -z "$docs" ]; then
        [ "$strict" = 'strict' ] && { echo "No tracked instruction file, nothing to check." >&2; exit 2; }
        return
    fi

    centered_text "Claims in instruction files"
    # shellcheck disable=SC2086
    if ! python3 "$checker" $docs --fail-on-breaks; then
        exit_code=1
    fi
}

# Without checking the return code, a typo in an option would silently fall back to the
# default branch, answering a different question than the caller asked.
OPTIONS=$(getopt -o t:c:r: --long target:,check:,resolve: -- "$@") || {
    echo "Usage: review_diff.sh [--target <branch>] [--check <name>] [--resolve <branch>]" >&2
    exit 2
}
eval set -- "$OPTIONS"

while true; do
    case "$1" in
        -t|--target) TARGET="$2"; shift 2 ;;
        -c|--check) CHECK="$2"; shift 2 ;;
        -r|--resolve) RESOLVE="$2"; shift 2 ;;
        --) break ;;
        *)
            echo "Unknown option '$1'." >&2
            echo "Usage: review_diff.sh [--target <branch>] [--check <name>] [--resolve <branch>]" >&2
            exit 2
            ;;
    esac
done

# Prints the resolved ref to stdout; exits 2 on an unknown branch. Keeps the
# "origin or local, otherwise fail" rule in one place for other callers.
if [ -n "${RESOLVE:-}" ]; then
    resolve_target "$RESOLVE"
    exit 0
fi

# One check standalone; used by CI jobs so they do not carry a copy of the same logic.
# Whole-repo checks do not need a target branch.
if [ -n "$CHECK" ]; then
    case "$CHECK" in
        conflict-markers) check_conflict_markers ;;
        agents-claims) check_agents_claims strict ;;
        *)
            echo "Unknown check name '$CHECK'. Available: conflict-markers, agents-claims." >&2
            exit 2
            ;;
    esac
    exit $exit_code
fi

[ -z "$TARGET" ] && TARGET="main"
# `exit` inside a command substitution ends only the subshell; propagate the code.
TARGET_REF=$(resolve_target "$TARGET") || exit $?
BASE=$(merge_base_with "$TARGET_REF") || exit 2

show_net_diff "$BASE" "$TARGET_REF"
warn_on_pure_deletions "$BASE"
check_orphan_references "$BASE"
check_conflict_markers
check_agents_claims

printf "\n"
exit $exit_code
