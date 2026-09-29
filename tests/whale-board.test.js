const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { summarizeWhaleBoard } = require('../lib/whale-board');

function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-board-'));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try { fn(dir); } finally { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('summarizeWhaleBoard reports unavailable when the directory does not exist', () => {
  withTempCwd((dir) => {
    const r = summarizeWhaleBoard(path.join(dir, 'no-such-dir'));
    assert.equal(r.available, false);
    assert.equal(r.n, 0);
  });
});

test('summarizeWhaleBoard keeps the most recent capture per game and flags it as unproven', () => {
  withTempCwd((dir) => {
    const captureDir = path.join(dir, 'data', 'kalshi-forward-fullgame');
    fs.mkdirSync(captureDir, { recursive: true });
    const base = { gamePk: 42, awayTeam: 'Toronto Blue Jays', homeTeam: 'Baltimore Orioles', kalshiPickTeam: 'Baltimore Orioles', firstPitchUtc: '2026-09-29T23:00:00Z' };
    fs.writeFileSync(path.join(captureDir, 'capture-1.json'), JSON.stringify({ records: [{
      ...base, capturedAt: '2026-09-29T21:00:00Z',
      whaleActivity: { bySide: { away: { available: true, n: 1, largestDollars: 6, totalDollars: 6, blockTradeCount: 0, largeTradeCount: 0, largeTradeDollars: 0 }, home: { available: true, n: 1, largestDollars: 14, totalDollars: 14, blockTradeCount: 0, largeTradeCount: 0, largeTradeDollars: 0 } }, largeTradeDirectionVsPick: 'neutral' }
    }] }));
    fs.writeFileSync(path.join(captureDir, 'capture-2.json'), JSON.stringify({ records: [{
      ...base, capturedAt: '2026-09-29T22:00:00Z',
      whaleActivity: { bySide: { away: { available: true, n: 3, largestDollars: 9, totalDollars: 20, blockTradeCount: 0, largeTradeCount: 0, largeTradeDollars: 0 }, home: { available: true, n: 4, largestDollars: 630, totalDollars: 700, blockTradeCount: 1, largeTradeCount: 1, largeTradeDollars: 630 } }, largeTradeDirectionVsPick: 'agrees_with_pick' }
    }] }));
    const r = summarizeWhaleBoard(captureDir);
    assert.equal(r.available, true);
    assert.equal(r.n, 1);
    const g = r.games[0];
    assert.equal(g.gamePk, 42);
    assert.equal(g.capturedAt, '2026-09-29T22:00:00Z'); // the later capture, not the earlier one
    assert.equal(g.largestDollars, 630);
    assert.equal(g.totalDollars, 720);
    assert.equal(g.blockTradeCount, 1);
    assert.equal(g.largeTradeDollars, 630);
    assert.equal(g.largeTradeDirectionVsPick, 'agrees_with_pick');
    assert.match(r.note, /UNPROVEN/);
  });
});

test('summarizeWhaleBoard skips records whose whale-trade fetch errored', () => {
  withTempCwd((dir) => {
    const captureDir = path.join(dir, 'data', 'kalshi-forward');
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(path.join(captureDir, 'capture-1.json'), JSON.stringify({ records: [
      { gamePk: 1, capturedAt: '2026-09-29T21:00:00Z', whaleActivity: { error: 'boom' } }
    ] }));
    const r = summarizeWhaleBoard(captureDir);
    assert.equal(r.available, false);
    assert.equal(r.n, 0);
  });
});
