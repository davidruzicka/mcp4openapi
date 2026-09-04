#!/usr/bin/env python3
"""
Enumerate checkable claims in an agent instruction file and resolve the mechanical ones.

Usage:
    python3 check_agents_claims.py AGENTS.md
    python3 check_agents_claims.py AGENTS.md --repo /path/to/repo
    python3 check_agents_claims.py AGENTS.md --json          # NDJSON, one object per claim
    python3 check_agents_claims.py AGENTS.md --only unresolved

What it resolves by itself (deterministic, no judgement):
    path        - does the referenced file/directory exist?
    script      - is the npm script defined in package.json?

What it only enumerates, for the model to adjudicate:
    snippet     - fenced code block: identifiers must resolve against real code
    config      - a claimed config value: read the config file and compare
    example     - a quoted commit/migration/ticket: check it exists in history
    process     - "on every deploy...", "someone has to..." : corroborate elsewhere

Exit code is 0 by default; with --fail-on-breaks it is 1 when some claim is BREAKS-ON-USE.
IMPRECISE and UNRESOLVED never fail the run - an unresolved claim is data, not an error.
"""

import argparse
import functools
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# `npm run foo` or `npm test`; the target must exist in package.json "scripts".
# Built-in npm subcommands (install, ci, audit, ...) are not claims about this repo.
NPM_RE = re.compile(r'\bnpm\s+(?:run\s+(?P<script>[\w:.-]+)|(?P<alias>test|start)\b)')
# backticked path with a file extension, or a directory path ending in /
_EXT = r'py|md|ts|tsx|js|mjs|cjs|json|toml|cfg|ini|sql|ya?ml|sh|html|conf'
PATH_RE = re.compile(rf'`(?P<path>[\w][\w./-]*(?:\.(?:{_EXT})|/))`')
# markdown link target that looks like a repo-relative file
LINK_RE = re.compile(r'\]\((?P<path>/?[\w][\w./-]*\.[a-z]{2,4})\)')
FENCE_RE = re.compile(r'^```(?P<lang>[\w]*)\s*$', re.M)
# claims that name a config knob and a value
CONFIG_RE = re.compile(r'`(?P<key>[\w-]+)`\s*(?:=|is|:)\s*`?(?P<value>[\w.-]+)`?')
# quoted commit-shaped examples (ticket-prefixed conventional subjects)
_TYPES = r'feat|fix|refactor|test|docs|chore|perf|ci'
EXAMPLE_RE = re.compile(rf'\b(?P<example>(?:[A-Z]{{2,}}-\d+)\s+(?:{_TYPES}):\s+\S.*)$', re.M)
PROCESS_RE = re.compile(
    r'\b(?:on every deploy|automatically registered|registered automatically|is sufficient'
    r'|happens automatically)\b',
    re.I,
)
# a path named in a prohibition ("never commit .env") is expected to be absent
PROHIBITION_RE = re.compile(r'\b(?:never|not |non-|don\'t|do not|avoid|must not|no )', re.I)
# How many characters around a path still count as the same clause.
CLAUSE_REACH = 60
# a path described as living on a deploy target, not in this working copy
ELSEWHERE_RE = re.compile(r'\b(?:production|on the server|deploy(?:ed|ment)?\b)', re.I)

SKIP_DIR_PARTS = {'node_modules', '.git', 'dist', 'coverage', 'html'}


def fenced_blocks(text):
    """Yield (lang, start_line, end_line, body) for each fenced code block."""
    lines = text.splitlines()
    open_at = None
    lang = ''
    for i, line in enumerate(lines, start=1):
        m = FENCE_RE.match(line)
        if not m:
            continue
        if open_at is None:
            open_at, lang = i, m.group('lang')
        else:
            yield lang, open_at, i, '\n'.join(lines[open_at:i - 1])
            open_at = None


def in_fence(line_no, blocks):
    return any(start < line_no < end for _, start, end, _ in blocks)


@functools.lru_cache(maxsize=None)
def npm_scripts(repo):
    """Script names defined in the repo root package.json, or None when it is missing."""
    pkg = Path(repo) / 'package.json'
    if not pkg.is_file():
        return None
    try:
        data = json.loads(pkg.read_text(encoding='utf-8', errors='replace'))
    except json.JSONDecodeError:
        return None
    return frozenset(data.get('scripts', {}))


@functools.lru_cache(maxsize=None)
def name_index(repo):
    """
    Map of file name -> paths, built in one walk.

    rglob filters only after the walk, so it would descend into node_modules on every
    lookup; pruning during the descent keeps the runtime proportional to the number of
    claims, not to the size of the JS dependencies.
    """
    index = {}
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_PARTS and not d.startswith('.')]
        for name in filenames:
            index.setdefault(name, []).append(Path(dirpath) / name)
    return index


def resolve_path(repo, doc_dir, raw):
    """
    Returns (verdict, evidence). Paths in a module-scoped instruction file are usually relative to
    that module, not to the repo root, so try the document's own directory first.
    """
    repo_abs = repo.resolve()
    bare = raw.lstrip('/')

    for base, label in ((doc_dir, 'relative to the file'), (repo, 'repo-relative')):
        candidate = (base / bare).resolve()
        try:
            candidate.relative_to(repo_abs)
        except ValueError:
            continue
        if candidate.exists():
            return 'TRUE', f'{candidate.relative_to(repo_abs)} ({label})'

    # A bare filename with no directory part is a reference to a kind of file, not to one location.
    if '/' not in bare:
        hits = name_index(repo).get(bare, [])[:3]
        if hits:
            return 'TRUE', f'{len(hits)}+ files named {bare}, e.g. {hits[0].relative_to(repo_abs)}'
        return 'UNRESOLVED', f'no file named {bare} found; may be illustrative'

    # Shorthand path: the doc names a real file but omits leading directories. Worth reporting,
    # because an agent cannot open it as written, but the fix is a longer path, not new code.
    tail = Path(bare).name
    for hit in name_index(repo).get(tail, []):
        if str(hit).endswith('/' + bare):
            return 'IMPRECISE', f'shorthand for {hit.relative_to(repo_abs)}'

    return 'BREAKS-ON-USE', 'missing under both the file directory and the repo root'


def git_has(repo, needle):
    """Search the whole history for a commit subject, not a bounded slice."""
    try:
        out = subprocess.run(
            ['git', '-C', str(repo), 'log', '--all', '--fixed-strings', f'--grep={needle.strip()}',
             '--pretty=%h', '-1'],
            capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return bool(out.stdout.strip())


def collect(doc, repo):
    text = doc.read_text(encoding='utf-8', errors='replace')
    blocks = list(fenced_blocks(text))
    claims = []

    seen = set()

    def add(kind, line, quote, verdict, evidence):
        # The same path often appears twice on one line (backticked and as a link target).
        key = (kind, line, quote.strip()[:200])
        if key in seen:
            return
        seen.add(key)
        claims.append({
            'kind': kind, 'line': line, 'quote': quote.strip()[:200],
            'verdict': verdict, 'evidence': evidence,
        })

    scripts = npm_scripts(str(repo))
    for line_no, line in enumerate(text.splitlines(), start=1):
        for m in NPM_RE.finditer(line):
            script = m.group('script') or m.group('alias')
            if scripts is None:
                add('script', line_no, m.group(0), 'UNRESOLVED', 'package.json not found or unreadable')
            elif script in scripts:
                add('script', line_no, m.group(0), 'TRUE', f'package.json defines "{script}"')
            else:
                near = sorted(s for s in scripts if script in s)
                add('script', line_no, m.group(0), 'BREAKS-ON-USE',
                    f'package.json has no script "{script}"'
                    + (f'; similar: {", ".join(near[:3])}' if near else ''))

        # A path the text places somewhere other than this working copy cannot be checked here.
        for m in list(PATH_RE.finditer(line)) + list(LINK_RE.finditer(line)):
            raw = m.group('path')
            if raw.startswith(('http', 'mailto')):
                continue
            # The prohibition must stand next to the path, not anywhere on the line.
            # Instruction texts are full of "not" and "never"; a line-wide search exempted
            # a fifth of all paths, including links the agent is supposed to follow.
            # A prohibition precedes the path ("never commit `x`"), an environment marker
            # follows it ("`x` (production)"), so each is searched on its own side.
            prefix = line[max(0, m.start() - CLAUSE_REACH):m.start()]
            clause = re.split(r'[;.]\s|\s--\s', prefix)[-1]
            suffix = line[m.end():m.end() + CLAUSE_REACH]
            prohibition = bool(
                PROHIBITION_RE.search(clause)
                or ELSEWHERE_RE.search(clause)
                or ELSEWHERE_RE.search(suffix)
            )
            verdict, detail = resolve_path(repo, doc.parent, raw)
            if verdict != 'TRUE' and prohibition:
                # "never commit credentials.json": absence is the point, not a defect
                verdict, detail = 'UNRESOLVED', 'absent, but the line reads as a prohibition'
            add('path', line_no, raw, verdict, detail)

        for m in EXAMPLE_RE.finditer(line):
            found = git_has(repo, m.group('example'))
            if found is None:
                add('example', line_no, m.group('example'), 'UNRESOLVED', 'git log unavailable')
            else:
                add('example', line_no, m.group('example'),
                    'TRUE' if found else 'IMPRECISE',
                    'present in git log' if found
                    else 'no commit with this exact subject in history (check casing)')

        if not in_fence(line_no, blocks):
            if PROCESS_RE.search(line):
                add('process', line_no, line, 'UNRESOLVED', 'corroborate against docs/ or code')
            for m in CONFIG_RE.finditer(line):
                add('config', line_no, m.group(0), 'UNRESOLVED',
                    f'read the config file and compare {m.group("key")}')

    for lang, start, end, body in blocks:
        add('snippet', start, f'{lang or "text"} block, lines {start}-{end}', 'UNRESOLVED',
            'resolve every identifier against real code; check it runs on paste')

    return claims


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('doc', nargs='+', help='instruction file(s) to audit')
    ap.add_argument('--repo', default='.', help='repo root the claims are about (default: cwd)')
    ap.add_argument('--json', action='store_true', help='NDJSON output')
    ap.add_argument('--only', choices=['unresolved', 'problems'], help='filter output')
    ap.add_argument('--fail-on-breaks', action='store_true',
                    help='exit 1 if any claim is BREAKS-ON-USE (for CI). IMPRECISE and UNRESOLVED never fail.')
    args = ap.parse_args()

    # Absolute from here on: walking a relative root yields relative hits, which then blow up
    # in relative_to() against an absolute root.
    repo = Path(args.repo).resolve()
    if not repo.is_dir():
        sys.exit(f'not a directory: {repo}')
    docs = [Path(d) for d in args.doc]
    for doc in docs:
        if not doc.is_file():
            sys.exit(f'not a file: {doc}')

    claims = []
    for doc in docs:
        for claim in collect(doc, repo):
            claim['doc'] = str(doc)
            claims.append(claim)

    if args.only == 'unresolved':
        claims = [c for c in claims if c['verdict'] == 'UNRESOLVED']
    elif args.only == 'problems':
        claims = [c for c in claims if c['verdict'] in ('BREAKS-ON-USE', 'IMPRECISE')]

    if args.json:
        for c in claims:
            print(json.dumps(c, ensure_ascii=False))
    else:
        for c in claims:
            print(f"{c['verdict']:<14} {c['kind']:<8} {c['doc']}:{c['line']:<5} {c['quote']}")
            if c['verdict'] != 'TRUE':
                print(f"{'':14} {'':8} `- {c['evidence']}")

        counts = {}
        for c in claims:
            counts[c['verdict']] = counts.get(c['verdict'], 0) + 1
        print('\nCOUNTS: ' + ', '.join(f'{k}={v}' for k, v in sorted(counts.items())) + f', total={len(claims)}')
        print('UNRESOLVED claims need a human or a model to adjudicate; they are not passes.')

    if args.fail_on_breaks:
        breaks = [c for c in claims if c['verdict'] == 'BREAKS-ON-USE']
        if breaks:
            print(f'\n{len(breaks)} claim(s) would break an agent that follows them. '
                  'Fix the code or the text.', file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()
