#!/usr/bin/env node

/**
 * Compare local diff coverage against a base ref using Istanbul coverage-final.json.
 *
 * Reports:
 * - patch line coverage on changed executable statements
 * - patch branch coverage on changed branch points (full/partial/miss)
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

function run(command) {
  // nosemgrep: detect-child-process -- dev-only script, command is hardcoded by caller, not user input
  return execSync(command, {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).toString();
}

function printHelp() {
  console.log('Usage: node scripts/check-diff-coverage.js [--base <ref>]');
  console.log('');
  console.log('Options:');
  console.log('  -b, --base <ref>  Base branch/ref to compare against');
  console.log('  -h, --help        Show help');
}

function getBaseFromArgs() {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--base' || arg === '-b') {
      const value = args[i + 1];
      if (value && !value.startsWith('-')) {
        return value;
      }
    }
    if (arg.startsWith('--base=')) {
      return arg.slice('--base='.length);
    }
  }

  const positional = args.find((arg) => !arg.startsWith('-'));
  return positional;
}

function getGhBaseRef() {
  const output = run('gh pr view --json baseRefName');
  const data = JSON.parse(output || '{}');
  if (typeof data.baseRefName !== 'string' || data.baseRefName.trim() === '') {
    return undefined;
  }
  return data.baseRefName.trim();
}

function resolveRemoteRef(name) {
  const candidate = `origin/${name}`;
  try {
    run(`git rev-parse --verify ${candidate}`);
    return candidate;
  } catch {
    return name;
  }
}

function listRemoteBranches() {
  const output = run('git for-each-ref --sort=-committerdate --format="%(refname:short)" refs/remotes');
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith('/HEAD'));
}

async function promptForBaseRef() {
  const branches = listRemoteBranches();
  if (branches.length > 0) {
    console.log('Available remote branches (newest first):');
    for (const branch of branches) {
      console.log(`  ${branch}`);
    }
    console.log('');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Enter base branch (e.g. origin/main): ');
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      throw new Error('Base branch is required.');
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

async function getComparisonBase() {
  const baseFromArgs = getBaseFromArgs();
  if (baseFromArgs) {
    return baseFromArgs;
  }

  try {
    const ghBase = getGhBaseRef();
    if (ghBase) {
      return resolveRemoteRef(ghBase);
    }
  } catch {
    // Fall through to interactive prompt.
  }

  return promptForBaseRef();
}

function parseChangedHunkLines(diff) {
  const changedByFile = new Map();
  let currentFile;
  let oldLine = 0;
  let newLine = 0;

  for (const rawLine of diff.split('\n')) {
    const line = rawLine;

    if (line.startsWith('+++ ')) {
      const filePath = line.slice(4).trim();
      if (!filePath.startsWith('b/')) {
        currentFile = undefined;
        continue;
      }
      currentFile = resolve(projectRoot, filePath.slice(2));
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!match) {
        oldLine = 0;
        newLine = 0;
        continue;
      }
      oldLine = Number.parseInt(match[1], 10);
      newLine = Number.parseInt(match[2], 10);
      continue;
    }

    if (!currentFile) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (!changedByFile.has(currentFile)) {
        changedByFile.set(currentFile, new Set());
      }
      changedByFile.get(currentFile).add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      if (!changedByFile.has(currentFile)) {
        changedByFile.set(currentFile, new Set());
      }
      changedByFile.get(currentFile).add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return changedByFile;
}

function getChangedHunkLines(baseRef) {
  try {
    const diff = run(`git diff ${baseRef}...HEAD --unified=0 --no-color`);
    if (diff.trim() !== '') {
      return parseChangedHunkLines(diff);
    }
  } catch {
    // Fall through to fallback diff.
  }

  try {
    const fallback = run('git diff HEAD~1..HEAD --unified=0 --no-color');
    return parseChangedHunkLines(fallback);
  } catch (error) {
    console.error(`Could not read git diff: ${error.message}`);
    return new Map();
  }
}

function normalizeCoveragePath(filePath) {
  if (!filePath) {
    return undefined;
  }
  if (filePath.startsWith('/')) {
    return filePath;
  }
  return resolve(projectRoot, filePath);
}

function loadCoverage() {
  try {
    const coveragePath = resolve(projectRoot, 'coverage/coverage-final.json');
    const raw = JSON.parse(readFileSync(coveragePath, 'utf-8'));
    const entries = new Map();

    for (const [key, entry] of Object.entries(raw)) {
      const normalizedPath = normalizeCoveragePath(entry?.path || key);
      if (!normalizedPath) {
        continue;
      }
      entries.set(normalizedPath, entry);
    }

    return entries;
  } catch (error) {
    console.error(`Could not load coverage data: ${error.message}`);
    console.error('Run: npm test -- --coverage');
    process.exit(1);
  }
}

function intersectsChangedLines(changedLines, startLine, endLine) {
  if (!Number.isInteger(startLine) || startLine <= 0) {
    return false;
  }
  const safeEnd = Number.isInteger(endLine) && endLine >= startLine ? endLine : startLine;
  for (const line of changedLines) {
    if (line >= startLine && line <= safeEnd) {
      return true;
    }
  }
  return false;
}

function analyzeLineCoverage(changedByFile, coverage) {
  let total = 0;
  let hits = 0;
  const missesByFile = new Map();

  for (const [filePath, changedLines] of changedByFile.entries()) {
    const entry = coverage.get(filePath);
    if (!entry) {
      continue;
    }

    const statementMap = entry.statementMap || {};
    const statementHits = entry.s || {};

    for (const [statementId, statementMeta] of Object.entries(statementMap)) {
      const startLine = statementMeta?.start?.line;
      const endLine = statementMeta?.end?.line;
      if (!intersectsChangedLines(changedLines, startLine, endLine)) {
        continue;
      }

      total += 1;
      if ((statementHits[statementId] || 0) > 0) {
        hits += 1;
      } else {
        if (!missesByFile.has(filePath)) {
          missesByFile.set(filePath, []);
        }
        missesByFile.get(filePath).push(startLine);
      }
    }
  }

  return {
    total,
    hits,
    misses: total - hits,
    coverage: total > 0 ? (hits / total) * 100 : 100,
    missesByFile,
  };
}

function branchTouchesChangedLines(branchMeta, changedLines) {
  const branchLine = branchMeta?.line;
  if (Number.isInteger(branchLine) && changedLines.has(branchLine)) {
    return true;
  }

  const locations = branchMeta?.locations;
  if (!Array.isArray(locations)) {
    return false;
  }

  for (const location of locations) {
    const startLine = location?.start?.line;
    const endLine = location?.end?.line;
    if (intersectsChangedLines(changedLines, startLine, endLine)) {
      return true;
    }
  }

  return false;
}

function analyzeBranchCoverage(changedByFile, coverage) {
  let total = 0;
  let hits = 0;
  let partials = 0;

  const missesByFile = new Map();
  const partialsByFile = new Map();

  for (const [filePath, changedLines] of changedByFile.entries()) {
    const entry = coverage.get(filePath);
    if (!entry || !entry.branchMap || !entry.b) {
      continue;
    }

    for (const [branchId, branchMeta] of Object.entries(entry.branchMap)) {
      if (!branchTouchesChangedLines(branchMeta, changedLines)) {
        continue;
      }

      const counts = entry.b[branchId];
      if (!Array.isArray(counts) || counts.length === 0) {
        continue;
      }

      total += 1;
      const coveredPaths = counts.filter((count) => (count || 0) > 0).length;
      const label = `${branchMeta?.line || 'unknown'}[${branchId}]`;

      if (coveredPaths === counts.length) {
        hits += 1;
      } else if (coveredPaths === 0) {
        if (!missesByFile.has(filePath)) {
          missesByFile.set(filePath, []);
        }
        missesByFile.get(filePath).push(label);
      } else {
        partials += 1;
        if (!partialsByFile.has(filePath)) {
          partialsByFile.set(filePath, []);
        }
        partialsByFile.get(filePath).push(label);
      }
    }
  }

  return {
    total,
    hits,
    partials,
    misses: total - hits - partials,
    fullCoverage: total > 0 ? (hits / total) * 100 : 100,
    missesByFile,
    partialsByFile,
  };
}

function formatPath(absPath) {
  return absPath.replace(`${projectRoot}/`, '');
}

function printMissesByFile(title, missesByFile) {
  if (missesByFile.size === 0) {
    return;
  }

  console.log(`\n${title}:`);
  for (const [filePath, misses] of missesByFile.entries()) {
    const sorted = [...new Set(misses)].sort((a, b) => {
      const left = Number.parseInt(String(a), 10);
      const right = Number.parseInt(String(b), 10);
      return left - right;
    });
    console.log(`${formatPath(filePath)} -> ${sorted.join(', ')}`);
  }
}

const baseRef = await getComparisonBase();
const changedByFile = getChangedHunkLines(baseRef);
const coverage = loadCoverage();

if (changedByFile.size === 0) {
  console.log('No changed lines detected for diff comparison.');
  process.exit(0);
}

const lineReport = analyzeLineCoverage(changedByFile, coverage);
const branchReport = analyzeBranchCoverage(changedByFile, coverage);

console.log(`Base ref: ${baseRef}`);
console.log(`Changed files in patch: ${changedByFile.size}`);
console.log(
  `Patch line coverage (changed executable statements): ${lineReport.hits}/${lineReport.total} (${lineReport.coverage.toFixed(2)}%)`
);
console.log(
  `Patch branch coverage (changed branch points): full ${branchReport.hits}/${branchReport.total} (${branchReport.fullCoverage.toFixed(2)}%), partial ${branchReport.partials}, miss ${branchReport.misses}`
);

if (lineReport.misses > 0) {
  printMissesByFile('Missed changed executable statements (line[statementId])', lineReport.missesByFile);
}

if (branchReport.partials > 0) {
  printMissesByFile('Partially covered changed branch points (line[branchId])', branchReport.partialsByFile);
}

if (branchReport.misses > 0) {
  printMissesByFile('Missed changed branch points (line[branchId])', branchReport.missesByFile);
}
