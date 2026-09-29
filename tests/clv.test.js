const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { computeCLV } = require('../lib/clv');

function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-clv-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try { fn(dir); } finally { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeCapture(dir, name, records) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ capturedAt: new Date().toISOString(), records }));
}

function writeGrades(dir, name, results) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ generatedAt: new Date().toISOString(), results }));
}

function entryRecord(overrides = {}) {
  return {
    gamePk: 5001,
    awayTeam: 'Away Team',
    homeTeam: 'Home Team',
    firstPitchUtc: '2026-09-20T19:00:00Z',
    capturedAt: '2026-09-20T17:00:00Z',
    kalshiPickSide: 'HOME',
    marketTrust: true,
    outcomeQuotes: { away: { mid: 0.45 }, home: { mid: 0.50 } },
    status: 'graded',
    win: true,
    ...overrides,
  };
}

test('reports unavailable when no grade report exists', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    const result = computeCLV(capDir);
    assert.equal(result.available, false);
  });
});

test('computes positive CLV for a winning pick that closed higher than its entry price', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    const entry = entryRecord({ win: true });
    writeGrades(capDir, 'grades-1.json', [entry]);
    writeCapture(capDir, 'capture-1.json', [entry]);
    writeCapture(capDir, 'capture-2.json', [{ ...entry, capturedAt: '2026-09-20T18:30:00Z', outcomeQuotes: { away: { mid: 0.40 }, home: { mid: 0.60 } } }]);
    const result = computeCLV(capDir);
    assert.equal(result.n, 1);
    const g = result.games[0];
    assert.equal(g.included, true);
    assert.ok(Math.abs(g.entryPrice - 0.50) < 1e-9);
    assert.ok(Math.abs(g.closingPrice - 0.60) < 1e-9);
    assert.ok(Math.abs(g.clv - 0.10) < 1e-9);
    assert.equal(g.positive, true);
    assert.equal(g.win, true);
  });
});

test('computes negative CLV for a losing pick that closed lower than its entry price', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    const entry = entryRecord({ gamePk: 5002, win: false });
    writeGrades(capDir, 'grades-1.json', [entry]);
    writeCapture(capDir, 'capture-1.json', [entry]);
    writeCapture(capDir, 'capture-2.json', [{ ...entry, capturedAt: '2026-09-20T18:30:00Z', outcomeQuotes: { away: { mid: 0.55 }, home: { mid: 0.42 } } }]);
    const result = computeCLV(capDir);
    const g = result.games[0];
    assert.ok(Math.abs(g.closingPrice - 0.42) < 1e-9);
    assert.ok(g.clv < 0);
    assert.equal(g.positive, false);
    assert.equal(g.win, false);
  });
});

test('excludes a game with only one capture -- no distinct closing price, not crashed on', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    const entry = entryRecord({ gamePk: 5003 });
    writeGrades(capDir, 'grades-1.json', [entry]);
    writeCapture(capDir, 'capture-1.json', [entry]);
    const result = computeCLV(capDir);
    assert.equal(result.n, 0);
    assert.equal(result.excluded, 1);
    assert.match(result.games[0].reason, /Only one capture/);
  });
});

test('excludes a pending (not yet graded) pick from the CLV calculation', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    const entry = entryRecord({ gamePk: 5004, status: 'pending', win: false });
    writeGrades(capDir, 'grades-1.json', [entry]);
    writeCapture(capDir, 'capture-1.json', [entry]);
    writeCapture(capDir, 'capture-2.json', [{ ...entry, capturedAt: '2026-09-20T18:30:00Z' }]);
    const result = computeCLV(capDir);
    assert.equal(result.n, 0);
    assert.match(result.games[0].reason, /not yet graded/);
  });
});

test('aggregates avg CLV and % positive correctly across a small synthetic sample', () => {
  withTempCwd((dir) => {
    const capDir = path.join(dir, 'capdir');
    fs.mkdirSync(capDir, { recursive: true });
    const entryWin = entryRecord({ gamePk: 6001, win: true });
    const entryLoss = entryRecord({ gamePk: 6002, win: false });
    writeGrades(capDir, 'grades-1.json', [entryWin, entryLoss]);
    writeCapture(capDir, 'capture-1.json', [entryWin, entryLoss]);
    writeCapture(capDir, 'capture-2.json', [
      { ...entryWin, capturedAt: '2026-09-20T18:30:00Z', outcomeQuotes: { away: { mid: 0.40 }, home: { mid: 0.60 } } }, // CLV +0.10
      { ...entryLoss, capturedAt: '2026-09-20T18:30:00Z', outcomeQuotes: { away: { mid: 0.55 }, home: { mid: 0.45 } } }, // CLV -0.05
    ]);
    const result = computeCLV(capDir);
    assert.equal(result.n, 2);
    assert.ok(Math.abs(result.avgCLV - 0.025) < 1e-9);
    assert.equal(result.positiveCount, 1);
    assert.equal(result.positivePct, 50);
  });
});

test('F5 and full-game directories are computed independently and never blended', () => {
  withTempCwd((dir) => {
    const f5Dir = path.join(dir, 'data', 'kalshi-forward');
    const fgDir = path.join(dir, 'data', 'kalshi-forward-fullgame');
    fs.mkdirSync(f5Dir, { recursive: true });
    fs.mkdirSync(fgDir, { recursive: true });
    const f5Entry = entryRecord({ gamePk: 7001, win: true });
    writeGrades(f5Dir, 'grades-1.json', [f5Entry]);
    writeCapture(f5Dir, 'capture-1.json', [f5Entry]);
    writeCapture(f5Dir, 'capture-2.json', [{ ...f5Entry, capturedAt: '2026-09-20T18:30:00Z', outcomeQuotes: { away: { mid: 0.40 }, home: { mid: 0.60 } } }]);
    // full-game dir has no data at all
    const f5Result = computeCLV(f5Dir);
    const fgResult = computeCLV(fgDir);
    assert.equal(f5Result.n, 1);
    assert.equal(fgResult.available, false);
  });
});
