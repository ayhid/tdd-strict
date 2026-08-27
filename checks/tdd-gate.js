#!/usr/bin/env node
'use strict';

/**
 * tdd-strict gate check.
 *
 * Usage: node tdd-gate.js <phaseDir> [phaseNumber]
 *
 * Contract (GSD command-exit-zero predicate):
 *   exit 0        -> gate passes
 *   exit non-zero -> gate result is block:true; stderr tail is shown to the user
 *
 * cwd is the project root (guaranteed by the predicate evaluator).
 *
 * For each type:tdd plan in the phase, asserts:
 *   RED    a commit matching ^test(<planId>):    exists
 *   GREEN  a commit matching ^feat(<planId>):    exists
 *   ORDER  the oldest RED commit is an ancestor of the oldest GREEN commit
 *
 * REFACTOR is optional by design and is reported but never required.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_DIR = process.cwd();
const OVERRIDE_ENV = 'GSD_TDD_STRICT_OVERRIDE';
const OVERRIDE_LOG = path.join('.planning', 'tdd-strict-overrides.log');
const MAX_STDERR = 1800; // predicate truncates the tail at 2000 chars

// ─── plan discovery ───────────────────────────────────────────────────────────

// Mirrors gsd-core's plan-scan: root layout plus the post-#3139 nested plans/ dir.
function isRootPlanFile(name) {
  return name === 'PLAN.md' || name.endsWith('-PLAN.md');
}

function isNestedPlanFile(name) {
  return /^PLAN-\d+.*\.md$/i.test(name) || /-PLAN-\d+.*\.md$/i.test(name);
}

function listPlanFiles(phaseDir) {
  const out = [];
  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(phaseDir);
  } catch {
    return out;
  }
  for (const name of rootEntries) {
    if (isRootPlanFile(name)) out.push(path.join(phaseDir, name));
  }
  const nestedDir = path.join(phaseDir, 'plans');
  if (fs.existsSync(nestedDir)) {
    let nested = [];
    try {
      nested = fs.readdirSync(nestedDir);
    } catch {
      nested = [];
    }
    for (const name of nested) {
      if (isNestedPlanFile(name)) out.push(path.join(nestedDir, name));
    }
  }
  return out.sort();
}

// CRLF-tolerant, same shape gsd-core uses (see #2449).
function readFrontmatter(file) {
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

function fmValue(fm, key) {
  const m = fm.match(new RegExp('^' + key + ':\\s*(.+?)\\s*$', 'm'));
  return m ? m[1].trim() : '';
}

/**
 * Commit scope is `{phase}-{plan}` (gsd-core/references/tdd.md <commit_pattern>).
 * Prefer frontmatter — `phase: 08-features` + `plan: 02` -> `08-02` — because it
 * survives both the root and nested filename layouts. Fall back to the filename
 * stem, which is what the first-party advisory checkpoint uses.
 */
function planIdFor(file, fm) {
  const phaseRaw = fmValue(fm, 'phase');
  const planRaw = fmValue(fm, 'plan');
  const phaseNum = (phaseRaw.match(/^\d+/) || [])[0];
  const planNum = (planRaw.match(/^\d+/) || [])[0];
  if (phaseNum && planNum) {
    return `${phaseNum}-${planNum.padStart(2, '0')}`;
  }
  return path.basename(file).replace(/-?PLAN.*\.md$/i, '').replace(/-$/, '');
}

// ─── git ──────────────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, {
    cwd: PROJECT_DIR,
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    timeout: 15000,
  });
}

/** Commit SHAs matching `^<type>(<planId>):`, newest first. Parens are literal in git's default BRE. */
function commitsFor(type, planId) {
  try {
    return git(['log', '--format=%H', `--grep=^${type}(${planId}):`, '--', '.'])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isAncestor(a, b) {
  try {
    git(['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

// ─── override receipt ─────────────────────────────────────────────────────────

/**
 * A deliberate bypass is allowed but never silent: it needs a reason string and
 * it is appended to a receipt in the repo. Ripping the gate out of config is the
 * alternative, and that leaves no trace at all.
 */
function recordOverride(reason) {
  const line = `${new Date().toISOString()}\t${reason}\n`;
  try {
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, OVERRIDE_LOG)), { recursive: true });
    fs.appendFileSync(path.join(PROJECT_DIR, OVERRIDE_LOG), line, 'utf-8');
  } catch {
    /* receipt is best-effort; never turn a logging failure into a block */
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

function main() {
  const phaseDirArg = (process.argv[2] || '').trim();
  const phaseNumber = (process.argv[3] || '').trim();

  const override = (process.env[OVERRIDE_ENV] || '').trim();
  if (override) {
    recordOverride(override);
    process.stdout.write(`tdd-strict: bypassed via ${OVERRIDE_ENV} — "${override}" (logged to ${OVERRIDE_LOG})\n`);
    return 0;
  }

  if (!phaseDirArg) {
    process.stdout.write('tdd-strict: no phase directory supplied; nothing to check.\n');
    return 0;
  }

  const phaseDir = path.isAbsolute(phaseDirArg) ? phaseDirArg : path.join(PROJECT_DIR, phaseDirArg);
  if (!fs.existsSync(phaseDir)) {
    process.stdout.write(`tdd-strict: phase directory not found (${phaseDirArg}); nothing to check.\n`);
    return 0;
  }

  const rows = [];
  for (const file of listPlanFiles(phaseDir)) {
    const fm = readFrontmatter(file);
    if (!fm) continue;
    if (/^status:\s*superseded\s*$/im.test(fm)) continue;
    if (!/^type:\s*tdd\s*$/m.test(fm)) continue;

    const planId = planIdFor(file, fm);
    const red = commitsFor('test', planId);
    const green = commitsFor('feat', planId);
    const refactor = commitsFor('refactor', planId);

    const missing = [];
    if (red.length === 0) missing.push('RED commit missing');
    if (green.length === 0) missing.push('GREEN commit missing');
    if (red.length > 0 && green.length > 0) {
      const oldestRed = red[red.length - 1];
      const oldestGreen = green[green.length - 1];
      if (!isAncestor(oldestRed, oldestGreen)) {
        missing.push('RED does not precede GREEN');
      }
    }

    rows.push({
      planId,
      file: path.relative(PROJECT_DIR, file),
      red: red.length > 0,
      green: green.length > 0,
      refactor: refactor.length > 0,
      missing,
    });
  }

  if (rows.length === 0) {
    const where = phaseNumber ? `phase ${phaseNumber}` : phaseDirArg;
    process.stdout.write(`tdd-strict: no type:tdd plans in ${where}; nothing to enforce.\n`);
    return 0;
  }

  const mark = (b) => (b ? '\u2713' : '\u2717');
  const lines = [
    `tdd-strict \u2014 ${rows.length} TDD plan(s)`,
    '',
    '| Plan  | RED | GREEN | REFACTOR | Status |',
    '|-------|-----|-------|----------|--------|',
  ];
  for (const r of rows) {
    const ok = r.missing.length === 0;
    lines.push(
      `| ${r.planId} |  ${mark(r.red)}  |   ${mark(r.green)}   |    ${r.refactor ? '\u2713' : '\u2014'}     | ${ok ? 'Pass' : 'FAIL'} |`,
    );
  }
  process.stdout.write(lines.join('\n') + '\n');

  const failures = rows.filter((r) => r.missing.length > 0);
  if (failures.length === 0) return 0;

  const detail = failures
    .map((r) => `  ${r.planId} (${r.file}): ${r.missing.join('; ')}`)
    .join('\n');
  const msg =
    `TDD gate violated in ${failures.length} of ${rows.length} plan(s):\n${detail}\n` +
    `Expected per plan: test(<phase>-<plan>) committed and failing, then feat(<phase>-<plan>).\n` +
    `To bypass deliberately: ${OVERRIDE_ENV}="reason" (appended to ${OVERRIDE_LOG}).`;
  process.stderr.write(msg.slice(0, MAX_STDERR) + '\n');
  return 1;
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`tdd-strict: check could not run \u2014 ${err && err.message ? err.message : err}\n`);
  process.exit(2);
}
