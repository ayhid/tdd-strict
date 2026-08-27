'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const GATE = path.join(__dirname, '..', 'checks', 'tdd-gate.js');

function sh(cwd, cmd, args) {
  execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

/** A throwaway git repo with a phase dir. Returns its path. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-strict-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'test@example.com']);
  sh(dir, 'git', ['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, '.planning', 'phases', '08-billing'), { recursive: true });
  return dir;
}

function writePlan(dir, name, frontmatter) {
  const file = path.join(dir, '.planning', 'phases', '08-billing', name);
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n<objective>x</objective>\n`, 'utf-8');
  return file;
}

function commit(dir, message) {
  const stamp = path.join(dir, 'work.txt');
  fs.appendFileSync(stamp, message + '\n', 'utf-8');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', message]);
}

function runGate(dir, phaseDir = '.planning/phases/08-billing', env = {}) {
  return spawnSync(process.execPath, [GATE, phaseDir, '08'], {
    cwd: dir,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

test('passes when RED precedes GREEN', () => {
  const dir = makeRepo();
  writePlan(dir, '08-01-PLAN.md', 'phase: 08-billing\nplan: 01\ntype: tdd');
  commit(dir, 'test(08-01): add failing test for invoice total');
  commit(dir, 'feat(08-01): implement invoice total');
  const res = runGate(dir);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Pass/);
});

test('blocks when the RED commit is missing', () => {
  const dir = makeRepo();
  writePlan(dir, '08-01-PLAN.md', 'phase: 08-billing\nplan: 01\ntype: tdd');
  commit(dir, 'feat(08-01): implement invoice total');
  const res = runGate(dir);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /RED commit missing/);
});

test('blocks when GREEN was committed before RED', () => {
  const dir = makeRepo();
  writePlan(dir, '08-01-PLAN.md', 'phase: 08-billing\nplan: 01\ntype: tdd');
  commit(dir, 'feat(08-01): implement invoice total');
  commit(dir, 'test(08-01): backfill a test');
  const res = runGate(dir);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /RED does not precede GREEN/);
});

test('ignores plans that are not type:tdd', () => {
  const dir = makeRepo();
  writePlan(dir, '08-01-PLAN.md', 'phase: 08-billing\nplan: 01\ntype: execute');
  commit(dir, 'feat(08-01): wire up the config screen');
  const res = runGate(dir);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /nothing to enforce/);
});

test('ignores superseded plans', () => {
  const dir = makeRepo();
  writePlan(dir, '08-01-PLAN.md', 'phase: 08-billing\nplan: 01\ntype: tdd\nstatus: superseded');
  commit(dir, 'chore: nothing to see here');
  const res = runGate(dir);
  assert.strictEqual(res.status, 0, res.stderr);
});

test('reads plans from the nested plans/ layout', () => {
  const dir = makeRepo();
  const nested = path.join(dir, '.planning', 'phases', '08-billing', 'plans');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(
    path.join(nested, 'PLAN-02-refunds.md'),
    '---\nphase: 08-billing\nplan: 02\ntype: tdd\n---\n',
    'utf-8',
  );
  commit(dir, 'test(08-02): add failing test for refund rounding');
  commit(dir, 'feat(08-02): implement refund rounding');
  const res = runGate(dir);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /08-02/);
});

test('override logs a receipt and passes', () => {
  const dir = makeRepo();
  writePlan(dir, '08-01-PLAN.md', 'phase: 08-billing\nplan: 01\ntype: tdd');
  const res = runGate(dir, '.planning/phases/08-billing', {
    GSD_TDD_STRICT_OVERRIDE: 'hotfix for prod incident 4412',
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const log = fs.readFileSync(path.join(dir, '.planning', 'tdd-strict-overrides.log'), 'utf-8');
  assert.match(log, /incident 4412/);
});

test('passes when the phase directory does not exist', () => {
  const dir = makeRepo();
  const res = runGate(dir, '.planning/phases/99-nope');
  assert.strictEqual(res.status, 0, res.stderr);
});
