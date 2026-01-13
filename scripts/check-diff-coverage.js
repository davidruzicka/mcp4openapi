#!/usr/bin/env node

/**
 * Check which changed lines in git diff are not covered by tests
 * This helps identify what Codecov is complaining about
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// Get changed files and lines from git diff
function getChangedLines() {
  try {
    const diff = execSync('git diff origin/main...HEAD --unified=0', { 
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe'
    }).toString();
    
    // Fallback to HEAD~1 if origin/main doesn't exist
    if (!diff || diff.trim() === '') {
      const diff2 = execSync('git diff HEAD~1..HEAD --unified=0', { 
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).toString();
      return parseDiff(diff2);
    }
    
    return parseDiff(diff);
  } catch (error) {
    // Try HEAD~1 as fallback
    try {
      const diff = execSync('git diff HEAD~1..HEAD --unified=0', { 
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe'
      }).toString();
      return parseDiff(diff);
    } catch (e) {
      console.error('Could not get git diff:', e.message);
      return new Map();
    }
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
const changedLines = getChangedLines();
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
