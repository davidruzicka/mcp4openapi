#!/usr/bin/env node

/**
 * Check which changed lines in git diff are not covered by tests
 * This helps identify what Codecov is complaining about
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// Get changed files and lines from git diff
async function getChangedLines() {
  try {
    const baseRef = await getComparisonBase();
    const diff = getDiff(`git diff ${baseRef}...HEAD --unified=0`);
    if (!diff || diff.trim() === '') {
      return getFallbackDiff();
    }
    return parseDiff(diff);
  } catch (error) {
    return getFallbackDiff();
  }
}

function getDiff(command) {
  return execSync(command, {
    cwd: projectRoot,
    encoding: 'utf-8',
    stdio: 'pipe'
  }).toString();
}

function printHelp() {
  console.log('Usage: node scripts/check-diff-coverage.js [--base <ref>]');
  console.log('');
  console.log('Options:');
  console.log('  -b, --base <ref>  Base branch or ref to compare against');
  console.log('  -h, --help        Show this help message');
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
      const value = arg.slice('--base='.length);
      if (value) {
        return value;
      }
    }
  }

  const positional = args.find((arg) => !arg.startsWith('-'));
  return positional;
}

function getGhBaseRef() {
  const output = getDiff('gh pr view --json baseRefName');
  const data = JSON.parse(output || '{}');
  if (typeof data.baseRefName !== 'string' || data.baseRefName.trim() === '') {
    return undefined;
  }
  return data.baseRefName.trim();
}

function resolveRemoteRef(name) {
  const candidate = `origin/${name}`;
  try {
    getDiff(`git rev-parse --verify ${candidate}`);
    return candidate;
  } catch (error) {
    return name;
  }
}

function listRemoteBranches() {
  const output = getDiff('git for-each-ref --sort=-committerdate --format="%(refname:short)" refs/remotes');
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
    const answer = await rl.question('Enter base branch to compare (e.g. origin/main): ');
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
  } catch (error) {
    // Ignore and prompt
  }

  return promptForBaseRef();
}

function getFallbackDiff() {
  try {
    const diff = getDiff('git diff HEAD~1..HEAD --unified=0');
    return parseDiff(diff);
  } catch (error) {
    console.error('Could not get git diff:', error.message);
    return new Map();
  }
}

function parseDiff(diff) {
  const changedLines = new Map(); // file -> Set of line numbers
  
  const lines = diff.split('\n');
  let currentFile = null;
  
  for (const line of lines) {
    // File header: @@ -old_start,old_count +new_start,new_count @@
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const start = parseInt(match[1]);
        const count = parseInt(match[2] || '1');
        for (let i = 0; i < count; i++) {
          if (!changedLines.has(currentFile)) {
            changedLines.set(currentFile, new Set());
          }
          changedLines.get(currentFile).add(start + i);
        }
      }
    }
    // File path: +++ b/path/to/file
    else if (line.startsWith('+++')) {
      const filePath = line.slice(6).trim();
      if (filePath.startsWith('src/')) {
        currentFile = resolve(projectRoot, filePath);
      } else {
        currentFile = null;
      }
    }
    // Added line: +code
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      // Line numbers are tracked by @@ headers, but we can also count
      // This is a fallback
    }
  }
  
  return changedLines;
}

// Load coverage data
function loadCoverage() {
  try {
    const coveragePath = resolve(projectRoot, 'coverage/coverage-final.json');
    const coverageData = JSON.parse(readFileSync(coveragePath, 'utf-8'));
    return coverageData;
  } catch (error) {
    console.error('Could not load coverage data:', error.message);
    console.error('Run: npm test -- --coverage');
    process.exit(1);
  }
}

// Check which changed lines are uncovered
function checkUncoveredLines(changedLines, coverage) {
  const uncovered = [];
  
  for (const [filePath, lineNumbers] of changedLines.entries()) {
    const coverageEntry = coverage[filePath];
    if (!coverageEntry) {
      continue; // File not in coverage (might be excluded)
    }
    
    const statements = coverageEntry.statementMap || {};
    const statementHits = coverageEntry.s || {};
    
    for (const lineNum of lineNumbers) {
      // Find statements on this line
      let isCovered = false;
      
      for (const [stmtId, stmt] of Object.entries(statements)) {
        const stmtLine = stmt.start.line;
        if (stmtLine === lineNum) {
          const hits = statementHits[stmtId] || 0;
          if (hits > 0) {
            isCovered = true;
            break;
          }
        }
      }
      
      if (!isCovered) {
        uncovered.push({ file: filePath, line: lineNum });
      }
    }
  }
  
  return uncovered;
}

// Main
const changedLines = await getChangedLines();
const coverage = loadCoverage();
const uncovered = checkUncoveredLines(changedLines, coverage);

if (uncovered.length === 0) {
  console.log('✓ All changed lines are covered!');
} else {
  console.log(`\n⚠ Found ${uncovered.length} uncovered changed lines:\n`);

  // Group by file
  const byFile = new Map();
  for (const item of uncovered) {
    const relPath = item.file.replace(projectRoot + '/', '');
    if (!byFile.has(relPath)) {
      byFile.set(relPath, []);
    }
    byFile.get(relPath).push(item.line);
  }

  for (const [file, lines] of byFile.entries()) {
    console.log(`${file}:`);
    lines.sort((a, b) => a - b);
    console.log(`  Lines: ${lines.join(', ')}`);
    console.log();
  }

  console.log(`\nTotal: ${uncovered.length} uncovered lines in ${byFile.size} files`);
}
