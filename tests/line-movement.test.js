const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { summarizeLineMovement } = require('../lib/line-movement');

function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-line-movement-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try { fn(dir); } finally { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeCapture(dir, name, records) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ capturedAt: new Date().toISOString(), records }));
}

function baseRecord(overrides = {}) {
  return {
    gamePk: 1001,
    awayTeam: 'Away Team',
    homeTeam: 'Home Team',
    firstPitchUtc: '2026-09-20T19:00:00Z',
    modelPickSide: 'HOME',
    kalshiPickSide: 'HOME',
    outcomeQuotes: { away: { mid: 0.45 }, home: { mid: 0.55 } },
    ...overrides,
  };
}

test('summarizeLineMovement reports unavailable when the directory does not exist', () => {
  withTempCwd((dir) => {
    const result = summarizeLineMovement(path.join(dir, 'data', 'kalshi-forward'));
    assert.equal(result.available, false);
  });
});

test('a game with only one capture is excluded with a clear reason, not crashed on', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    writeCapture(capDir, 'capture-1.json', [baseRecord({ capturedAt: '2026-09-20T17:00:00Z' })]);
    const result = summarizeLineMovement(capDir);
    assert.equal(result.available, true);
    assert.equal(result.n, 0);
    assert.equal(result.excluded, 1);
    assert.match(result.games[0].reason, /Only 1 capture/);
  });
});

test('computes opening/closing price and net movement sign/magnitude across a chain of captures', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    writeCapture(capDir, 'capture-1.json', [baseRecord({ capturedAt: '2026-09-20T17:00:00Z', outcomeQuotes: { away: { mid: 0.45 }, home: { mid: 0.50 } } })]);
    writeCapture(capDir, 'capture-2.json', [baseRecord({ capturedAt: '2026-09-20T17:20:00Z', outcomeQuotes: { away: { mid: 0.42 }, home: { mid: 0.53 } } })]);
    writeCapture(capDir, 'capture-3.json', [baseRecord({ capturedAt: '2026-09-20T17:40:00Z', outcomeQuotes: { away: { mid: 0.38 }, home: { mid: 0.58 } } })]);
    const result = summarizeLineMovement(capDir, { sideField: 'modelPickSide' });
    assert.equal(result.n, 1);
    const g = result.games[0];
    assert.equal(g.pickSide, 'HOME');
    assert.equal(g.captureCount, 3);
    assert.ok(Math.abs(g.openingPrice - 0.50) < 1e-9);
    assert.ok(Math.abs(g.closingPrice - 0.58) < 1e-9);
    assert.ok(Math.abs(g.netMovement - 0.08) < 1e-9);
    assert.equal(g.movedToward, true);
    assert.equal(g.movedAway, false);
  });
});

test('flags movement away from the picked side when the price falls', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    writeCapture(capDir, 'capture-1.json', [baseRecord({ gamePk: 2002, capturedAt: '2026-09-20T17:00:00Z', outcomeQuotes: { away: { mid: 0.40 }, home: { mid: 0.60 } } })]);
    writeCapture(capDir, 'capture-2.json', [baseRecord({ gamePk: 2002, capturedAt: '2026-09-20T17:30:00Z', outcomeQuotes: { away: { mid: 0.48 }, home: { mid: 0.52 } } })]);
    const result = summarizeLineMovement(capDir);
    const g = result.games[0];
    assert.equal(g.movedAway, true);
    assert.equal(result.movedAwayCount, 1);
    assert.equal(result.movedAwayPct, 100);
  });
});

test('excludes a game when the closing capture has no usable model pick side', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    writeCapture(capDir, 'capture-1.json', [baseRecord({ gamePk: 3003, capturedAt: '2026-09-20T17:00:00Z', modelPickSide: null })]);
    writeCapture(capDir, 'capture-2.json', [baseRecord({ gamePk: 3003, capturedAt: '2026-09-20T17:30:00Z', modelPickSide: null })]);
    const result = summarizeLineMovement(capDir);
    assert.equal(result.n, 0);
    assert.match(result.games[0].reason, /No usable pick side/);
  });
});

test('deduplicates repeated captures at the same capturedAt timestamp', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    writeCapture(capDir, 'capture-1.json', [baseRecord({ gamePk: 4004, capturedAt: '2026-09-20T17:00:00Z' })]);
    writeCapture(capDir, 'capture-2.json', [baseRecord({ gamePk: 4004, capturedAt: '2026-09-20T17:00:00Z' })]);
    const result = summarizeLineMovement(capDir);
    assert.equal(result.n, 0);
    assert.match(result.games[0].reason, /Only 1 capture/);
  });
});
