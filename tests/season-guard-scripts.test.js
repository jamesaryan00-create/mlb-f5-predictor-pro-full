// Integration coverage for the season-guard wiring in the actual cron scripts
// (scripts/kalshi-forward.js, scripts/kalshi-forward-fullgame.js, scripts/model-forward.js).
// Spawns each script for real (temp cwd, mocked global.fetch via NODE_OPTIONS=--require preload
// so no real network call happens) and asserts the gameless-day path logs a single skip line
// and writes NOTHING new under data/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'season-guard-preload-empty.js');

function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'season-guard-scripts-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function listFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function runScript(scriptRelPath, args, cwd) {
  return execFileSync(process.execPath, [path.join(REPO_ROOT, scriptRelPath), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require ${PRELOAD}` }
  });
}

test('kalshi-forward.js capture: gameless day is skipped, no capture-*.json written', () => {
  withTempCwd((dir) => {
    const out = runScript('scripts/kalshi-forward.js', ['capture'], dir);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.skipped, true);
    assert.match(parsed.reason, /No MLB games scheduled/);
    assert.equal(listFiles(path.join(dir, 'data', 'kalshi-forward')).filter((f) => f.startsWith('capture-')).length, 0);
  });
});

test('kalshi-forward.js grade: nothing pending is skipped, no grades-*.json written', () => {
  withTempCwd((dir) => {
    const out = runScript('scripts/kalshi-forward.js', ['grade'], dir);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.skipped, true);
    assert.equal(listFiles(path.join(dir, 'data', 'kalshi-forward')).filter((f) => f.startsWith('grades-')).length, 0);
  });
});

test('kalshi-forward-fullgame.js capture: gameless day is skipped, no capture-*.json written', () => {
  withTempCwd((dir) => {
    const out = runScript('scripts/kalshi-forward-fullgame.js', ['capture'], dir);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.skipped, true);
    assert.match(parsed.reason, /No MLB games scheduled/);
    assert.equal(listFiles(path.join(dir, 'data', 'kalshi-forward-fullgame')).filter((f) => f.startsWith('capture-')).length, 0);
  });
});

test('kalshi-forward-fullgame.js grade: nothing pending is skipped, no grades-*.json written', () => {
  withTempCwd((dir) => {
    const out = runScript('scripts/kalshi-forward-fullgame.js', ['grade'], dir);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.skipped, true);
    assert.equal(listFiles(path.join(dir, 'data', 'kalshi-forward-fullgame')).filter((f) => f.startsWith('grades-')).length, 0);
  });
});

test('model-forward.js pick: gameless day is skipped, no picks-<date>.json written', () => {
  withTempCwd((dir) => {
    const out = runScript('scripts/model-forward.js', ['pick', '2026-12-01'], dir);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.skipped, true);
    assert.match(parsed.reason, /No MLB games scheduled/);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'model-forward', 'picks-2026-12-01.json')), false);
  });
});

test('model-forward.js grade: no picks files at all means no grade reports and no crash/spam', () => {
  withTempCwd((dir) => {
    const out = runScript('scripts/model-forward.js', ['grade'], dir);
    const parsed = JSON.parse(out.trim());
    assert.deepEqual(parsed.gradedDates, []);
    assert.equal(listFiles(path.join(dir, 'data', 'model-forward')).filter((f) => f.startsWith('grades-')).length, 0);
  });
});
