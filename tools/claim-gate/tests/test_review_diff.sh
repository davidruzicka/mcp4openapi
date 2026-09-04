#!/bin/bash
# Tests of the pre-commit gate. Every check has a scenario that MUST fail it -
# for a detector the dangerous direction is "passes when it should not", not the
# other way round.
#
# Runs without arguments, builds temporary repositories in /tmp and cleans up.

set -u

GATE="$(cd "$(dirname "$0")/.." && pwd)/review_diff.sh"
failures=0

report() {
    if [ "$1" = 'ok' ]; then
        printf '  ok    %s\n' "$2"
    else
        printf '  FAIL  %s\n' "$2"
        failures=$((failures + 1))
    fi
}

expect_exit() {
    local expected="$1" actual="$2" name="$3"
    [ "$expected" = "$actual" ] && report ok "$name" || report fail "$name (expected $expected, got $actual)"
}

# Repository with one function and its call site; branch 'baseline' holds the pre-change state.
new_repo() {
    local dir
    dir=$(mktemp -d)
    git -C "$dir" init -q .
    git -C "$dir" config user.email test@example.com
    git -C "$dir" config user.name Test
    mkdir -p "$dir/pkg"
    printf 'export function refreshV2() {\n  return 1;\n}\n' > "$dir/pkg/a.ts"
    printf 'import { refreshV2 } from "./a";\nexport function use() {\n  return refreshV2();\n}\n' > "$dir/pkg/b.ts"
    git -C "$dir" add -A
    git -C "$dir" commit -qm base
    git -C "$dir" branch -q baseline
    echo "$dir"
}

run_gate() {
    local dir="$1"; shift
    (cd "$dir" && "$GATE" "$@" >/dev/null 2>&1)
    echo $?
}

printf 'Checks that must fail:\n'

# Orphaned reference caught before the commit - exactly how the gate is run.
repo=$(new_repo)
printf 'export const nothing = 0;\n' > "$repo/pkg/a.ts"
expect_exit 1 "$(run_gate "$repo" --target baseline)" 'orphaned reference in an uncommitted change'
git -C "$repo" commit -qam removed
expect_exit 1 "$(run_gate "$repo" --target baseline)" 'orphaned reference after commit'
rm -rf "$repo"

# An arrow-function const must not slip through name extraction. It must already exist
# on the baseline - a function added and removed within the range never appears in the
# net diff, and that is correct.
repo=$(mktemp -d)
git -C "$repo" init -q .
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
mkdir -p "$repo/pkg"
printf 'export const loadAll = async () => {\n  return 2;\n};\n' > "$repo/pkg/a.ts"
printf 'import { loadAll } from "./a";\nexport function use() {\n  return loadAll();\n}\n' > "$repo/pkg/b.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm base
git -C "$repo" branch -q baseline
printf 'export const nothing = 0;\n' > "$repo/pkg/a.ts"
expect_exit 1 "$(run_gate "$repo" --target baseline)" 'orphaned reference to an arrow-function const'
rm -rf "$repo"

# The same function name already exists elsewhere in the repo - the check must not
# switch itself off; what decides is the drop in definitions against the merge base.
repo=$(mktemp -d)
git -C "$repo" init -q .
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
mkdir -p "$repo/pkg"
printf 'export function refreshV2() {\n  return 1;\n}\n' > "$repo/pkg/a.ts"
printf 'export function refreshV2() {\n  return 9;\n}\n' > "$repo/pkg/d.ts"
printf 'import { refreshV2 } from "./a";\nexport function use() {\n  return refreshV2();\n}\n' > "$repo/pkg/b.ts"
git -C "$repo" add -A
git -C "$repo" commit -qm base
git -C "$repo" branch -q baseline
printf 'export const nothing = 0;\n' > "$repo/pkg/a.ts"
expect_exit 1 "$(run_gate "$repo" --target baseline)" 'orphaned reference despite same-name function elsewhere'
rm -rf "$repo"

# Moving a function to another file is not a removal and must not be reported.
repo=$(new_repo)
printf 'export const nothing = 0;\n' > "$repo/pkg/a.ts"
printf 'export function refreshV2() {\n  return 1;\n}\n' > "$repo/pkg/moved.ts"
git -C "$repo" add -A
expect_exit 0 "$(run_gate "$repo" --target baseline)" 'moved function is not reported'
rm -rf "$repo"

repo=$(new_repo)
printf 'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n>>>>>>> other\n' > "$repo/pkg/c.tsx"
git -C "$repo" add -A
expect_exit 1 "$(run_gate "$repo" --target baseline)" 'conflict marker in .tsx'
expect_exit 1 "$(run_gate "$repo" --check conflict-markers)" 'conflict marker via --check'
rm -rf "$repo"

repo=$(new_repo)
expect_exit 2 "$(run_gate "$repo" --target branch-does-not-exist)" 'unknown target branch'
expect_exit 2 "$(run_gate "$repo" --resolve branch-does-not-exist)" 'unknown branch for --resolve'
expect_exit 2 "$(run_gate "$repo" --check nonsense)" 'unknown check name'
expect_exit 2 "$(run_gate "$repo" --taget baseline)" 'typo in an option'
rm -rf "$repo"

printf 'Messages that must guide the reader:\n'

# An error message without the list of options forces the reader into the source.
repo=$(new_repo)
out=$( (cd "$repo" && "$GATE" --check nonsense) 2>&1 )
case "$out" in
    *conflict-markers*agents-claims*) report ok 'unknown check name lists available checks' ;;
    *) report fail "unknown check name does not list available checks: $out" ;;
esac

out=$( (cd "$repo" && "$GATE" --taget baseline) 2>&1 )
case "$out" in
    *Usage:*) report ok 'unknown option prints usage' ;;
    *) report fail "unknown option does not print usage: $out" ;;
esac

out=$( (cd "$repo" && "$GATE" --target baselinee) 2>&1 )
case "$out" in
    *baseline*) report ok 'unknown branch suggests a similar one' ;;
    *) report fail "unknown branch does not suggest a similar one: $out" ;;
esac
rm -rf "$repo"

printf 'Checks that must pass:\n'

repo=$(new_repo)
expect_exit 0 "$(run_gate "$repo" --target baseline)" 'clean tree'
expect_exit 0 "$(run_gate "$repo" --check conflict-markers)" 'clean tree via --check'
# A run from a subdirectory must see the whole repository, not a fraction of it.
printf 'export const nothing = 0;\n' > "$repo/pkg/a.ts"
expect_exit 1 "$(cd "$repo/pkg" && "$GATE" --target baseline >/dev/null 2>&1; echo $?)" 'run from a subdirectory finds the same'
rm -rf "$repo"

# The foreign-deletion warning must count LINES, not blame commit groups: one
# foreign commit adding three lines is three deleted lines, and the author's own
# single-line commit must not cancel out a multi-line foreign group.
repo=$(new_repo)
git -C "$repo" config user.email other@example.com
printf 'alpha\nbeta\ngamma\n' > "$repo/pkg/foreign.txt.ts"
git -C "$repo" add -A && git -C "$repo" commit -qm 'foreign lines'
git -C "$repo" config user.email test@example.com
printf 'mine\n' >> "$repo/pkg/foreign.txt.ts"
git -C "$repo" add -A && git -C "$repo" commit -qm 'own line'
git -C "$repo" branch -qf baseline
rm "$repo/pkg/foreign.txt.ts"
out=$(cd "$repo" && "$GATE" --target baseline 2>&1) || true
case "$out" in
    *'-3 lines written by someone else'*) report ok 'foreign-deletion warning counts lines, not commits' ;;
    *) report fail "foreign-deletion warning miscounts: $(printf '%s' "$out" | grep 'someone else' || echo 'no warning emitted')" ;;
esac
rm -rf "$repo"

printf '\n'
if [ "$failures" -gt 0 ]; then
    printf 'Failed checks: %s\n' "$failures"
    exit 1
fi
printf 'All passed.\n'
