"""Tests of the instruction-file claim checker.

A false positive is worse here than a missed finding - a check that cries wolf on
correct documentation gets disabled within a month. Every verdict is tested both ways.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parent.parent / 'check_agents_claims.py'
REPO = Path(__file__).resolve().parents[3]


def _load_module():
    spec = importlib.util.spec_from_file_location('check_agents_claims', TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _verdicts(tmp_path: Path, text: str) -> dict[str, str]:
    """Run the checker over one document and return a map of claim -> verdict."""
    doc = tmp_path / 'AGENTS.md'
    doc.write_text(text, encoding='utf-8')
    result = subprocess.run(
        [sys.executable, str(TOOL), str(doc), '--repo', str(REPO)],
        capture_output=True, text=True, check=False,
    )
    verdicts = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4 and parts[0].isupper():
            verdicts[parts[3].strip()] = parts[0]
    return verdicts


def test_existing_npm_script_is_true(tmp_path):
    verdicts = _verdicts(tmp_path, 'Run `npm run typecheck` before finishing work.\n')

    assert verdicts['npm run typecheck'] == 'TRUE'


def test_npm_test_alias_is_true(tmp_path):
    verdicts = _verdicts(tmp_path, 'Run `npm test` to verify.\n')

    assert verdicts['npm test'] == 'TRUE'


def test_missing_npm_script_breaks(tmp_path):
    verdicts = _verdicts(tmp_path, 'Run `npm run definitely-not-a-script` to build.\n')

    assert verdicts['npm run definitely-not-a-script'] == 'BREAKS-ON-USE'


def test_existing_path_is_true(tmp_path):
    verdicts = _verdicts(tmp_path, 'See `src/core/errors.ts` for error types.\n')

    assert verdicts['src/core/errors.ts'] == 'TRUE'


def test_missing_path_breaks(tmp_path):
    verdicts = _verdicts(tmp_path, 'See `src/definitely_missing_file.ts` for details.\n')

    assert verdicts['src/definitely_missing_file.ts'] == 'BREAKS-ON-USE'


def test_prohibited_path_is_not_a_break(tmp_path):
    """A prohibited path is absent on purpose; that is not a broken claim."""
    verdicts = _verdicts(tmp_path, 'Never commit `credentials.json` to the repository.\n')

    assert verdicts['credentials.json'] == 'UNRESOLVED'


def test_prohibition_must_stand_next_to_the_path(tmp_path):
    """A "not" elsewhere in the sentence must not exempt a path the agent should follow."""
    verdicts = _verdicts(
        tmp_path,
        'Do not guess the layout; read `src/definitely_missing_file.ts` first.\n',
    )

    assert verdicts['src/definitely_missing_file.ts'] == 'BREAKS-ON-USE'


def test_fail_on_breaks_exit_code(tmp_path):
    doc = tmp_path / 'AGENTS.md'
    doc.write_text('Run `npm run definitely-not-a-script`.\n', encoding='utf-8')

    without_flag = subprocess.run(
        [sys.executable, str(TOOL), str(doc), '--repo', str(REPO)], capture_output=True, check=False)
    with_flag = subprocess.run(
        [sys.executable, str(TOOL), str(doc), '--repo', str(REPO), '--fail-on-breaks'],
        capture_output=True, check=False)

    assert without_flag.returncode == 0
    assert with_flag.returncode == 1


def test_repo_instruction_files_have_no_breaks():
    """The tracked instruction files must be true - otherwise the CI job is pointless."""
    docs = subprocess.run(
        ['git', 'ls-files', 'AGENTS.md', '*/AGENTS.md', 'CLAUDE.md', 'IMPLEMENTATION.md'],
        cwd=REPO, capture_output=True, text=True, check=True).stdout.split()

    result = subprocess.run([sys.executable, str(TOOL), *docs, '--repo', str(REPO), '--fail-on-breaks'],
                            cwd=REPO, capture_output=True, text=True, check=False)

    assert result.returncode == 0, result.stdout[-2000:]


def test_module_exposes_expected_regexes():
    module = _load_module()

    assert module.NPM_RE.search('npm run test:e2e').group('script') == 'test:e2e'
    assert module.NPM_RE.search('run npm test now').group('alias') == 'test'
