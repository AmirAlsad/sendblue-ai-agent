#!/usr/bin/env node
/**
 * Simple runner for the unit-test suite.
 *
 * Walks `tests/unit/` recursively, runs every `*.test.js` as a child process,
 * prints a per-file pass/fail summary, and exits non-zero if anything failed.
 *
 * Supports an optional `--grep <substring>` argument that filters by path.
 *
 *   node tests/unit/run-all.js
 *   node tests/unit/run-all.js --grep gate
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const UNIT_ROOT = path.resolve(__dirname);

function collectTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const gi = args.indexOf('--grep');
  const grep = gi >= 0 ? args[gi + 1] : null;
  return { grep };
}

const { grep } = parseArgs();
let files = collectTestFiles(UNIT_ROOT);
if (grep) {
  files = files.filter(f => f.includes(grep));
  if (files.length === 0) {
    console.error(`No tests matched --grep "${grep}"`);
    process.exit(1);
  }
}
files.sort();

let totalFiles = 0;
let failedFiles = 0;
const failures = [];

for (const file of files) {
  totalFiles += 1;
  const rel = path.relative(path.dirname(UNIT_ROOT) + '/..', file);
  process.stdout.write(`\n▶ ${rel}\n`);
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (res.status !== 0) {
    failedFiles += 1;
    failures.push(rel);
  }
}

console.log('\n' + '='.repeat(60));
if (failedFiles === 0) {
  console.log(`✓ ${totalFiles} file(s) passed.`);
  process.exit(0);
}
console.log(`✗ ${failedFiles}/${totalFiles} file(s) failed:`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
