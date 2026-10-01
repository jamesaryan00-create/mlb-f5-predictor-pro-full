const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { readCaptureRecords, latestQuoteByGamePk, MAX_CAPTURE_AGE_MINUTES } = require('../lib/kalshi-capture-store');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshi-capture-store-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function writeCapture(dir, name, capturedAt, records) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ capturedAt, records }));
}

test('latestQuoteByGamePk: this module makes zero network calls', () => {
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('network call attempted -- this path must be disk-only'); };
  try {
    withTempDir((dir) => {
      writeCapture(dir, 'capture-1.json', '2026-09-29T18:00:00Z', [{ gamePk: 1, capturedAt: '2026-09-29T18:00:00Z', kalshiPickSide: 'HOME', kalshiPickTeam: 'X', kalshiConfidence: 0.6 }]);
      const now = Date.parse('2026-09-29T18:05:00Z');
      const m = latestQuoteByGamePk(dir, now);
      assert.equal(m.size, 1);
    });
  } finally { global.fetch = originalFetch; }
});

test('latestQuoteByGamePk keeps the MOST RECENT capture per gamePk, not the first-seen', () => {
  withTempDir((dir) => {
    writeCapture(dir, 'capture-1.json', '2026-09-29T18:00:00Z', [{ gamePk: 42, capturedAt: '2026-09-29T18:00:00Z', kalshiConfidence: 0.55, kalshiPickTeam: 'Old pick' }]);
    writeCapture(dir, 'capture-2.json', '2026-09-29T18:20:00Z', [{ gamePk: 42, capturedAt: '2026-09-29T18:20:00Z', kalshiConfidence: 0.61, kalshiPickTeam: 'New pick' }]);
    // Intentionally written/discovered out of chronological file order to prove the SELECTION is
    // by capturedAt, not by file iteration order.
    writeCapture(dir, 'capture-0-earlier-alphabetically.json', '2026-09-29T17:00:00Z', [{ gamePk: 42, capturedAt: '2026-09-29T17:00:00Z', kalshiConfidence: 0.50, kalshiPickTeam: 'Oldest pick' }]);
    const now = Date.parse('2026-09-29T18:21:00Z');
    const m = latestQuoteByGamePk(dir, now);
    assert.equal(m.get(42).kalshiPickTeam, 'New pick');
  });
});

test('latestQuoteByGamePk rejects a capture older than MAX_CAPTURE_AGE_MINUTES with no entry', () => {
  withTempDir((dir) => {
    const staleAt = '2026-09-29T17:00:00Z'; // 61 minutes before `now` below
    writeCapture(dir, 'capture-1.json', staleAt, [{ gamePk: 7, capturedAt: staleAt, kalshiConfidence: 0.6, kalshiPickTeam: 'Stale pick' }]);
    const now = Date.parse('2026-09-29T18:01:00Z');
    assert.ok((now - Date.parse(staleAt)) / 60000 > MAX_CAPTURE_AGE_MINUTES);
    const m = latestQuoteByGamePk(dir, now);
    assert.equal(m.has(7), false);
  });
});

test('latestQuoteByGamePk accepts a capture just inside the freshness window', () => {
  withTempDir((dir) => {
    const freshAt = '2026-09-29T18:00:00Z'; // 30 minutes before `now`, inside the 45-min window
    writeCapture(dir, 'capture-1.json', freshAt, [{ gamePk: 9, capturedAt: freshAt, kalshiConfidence: 0.6, kalshiPickTeam: 'Fresh pick' }]);
    const now = Date.parse('2026-09-29T18:30:00Z');
    const m = latestQuoteByGamePk(dir, now);
    assert.equal(m.get(9).kalshiPickTeam, 'Fresh pick');
  });
});

test('a missing capture directory is handled gracefully, not a crash', () => {
  withTempDir((dir) => {
    const m = latestQuoteByGamePk(path.join(dir, 'does-not-exist'));
    assert.equal(m.size, 0);
  });
});

test('a corrupt capture file is skipped, not a crash', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'capture-bad.json'), 'not json');
    writeCapture(dir, 'capture-good.json', '2026-09-29T18:00:00Z', [{ gamePk: 1, capturedAt: '2026-09-29T18:00:00Z', kalshiConfidence: 0.6, kalshiPickTeam: 'OK' }]);
    const now = Date.parse('2026-09-29T18:05:00Z');
    const m = latestQuoteByGamePk(dir, now);
    assert.equal(m.get(1).kalshiPickTeam, 'OK');
  });
});

test('readCaptureRecords falls back to the file-level capturedAt when a record has none of its own', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'capture-1.json'), JSON.stringify({ capturedAt: '2026-09-29T18:00:00Z', records: [{ gamePk: 3, kalshiConfidence: 0.6, kalshiPickTeam: 'No own timestamp' }] }));
    const recs = readCaptureRecords(dir);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].capturedAt, '2026-09-29T18:00:00Z');
  });
});

// getLiveKalshiQuotesForGames() (lib/mlb.js) reads data/kalshi-forward-fullgame/ and
// data/kalshi-forward/ relative to process.cwd() via this module -- exercise the real wiring
// end-to-end in an isolated temp cwd, proving it never hits the network and returns exactly what
// this module's own disk-based lookup would.
async function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshi-capture-store-cwd-'));
  const prevCwd = process.cwd();
  fs.mkdirSync(path.join(dir, 'data', 'kalshi-forward-fullgame'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'kalshi-forward'), { recursive: true });
  process.chdir(dir);
  try { return await fn(dir); } finally { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('lib/mlb.js getLiveKalshiQuotesForGames() reads the two capture directories from process.cwd(), never the network', async () => {
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('network call attempted -- this path must be disk-only'); };
  try {
    await withTempCwd((dir) => {
      // Relative to the real clock (a few minutes ago), not a hardcoded date -- a fixed past
      // timestamp becomes a time bomb once real time moves more than MAX_CAPTURE_AGE_MINUTES
      // past it (this test started failing on its own days after it was written for exactly
      // that reason).
      const recentAt = new Date(Date.now() - 5 * 60000).toISOString();
      writeCapture(path.join(dir, 'data', 'kalshi-forward-fullgame'), 'capture-1.json', recentAt,
        [{ gamePk: 555, capturedAt: recentAt, kalshiPickSide: 'HOME', kalshiPickTeam: 'Home Team', kalshiConfidence: 0.6, tier: 'PASS' }]);
      writeCapture(path.join(dir, 'data', 'kalshi-forward'), 'capture-1.json', recentAt,
        [{ gamePk: 555, capturedAt: recentAt, kalshiPickSide: 'AWAY', kalshiPickTeam: 'Away Team', kalshiConfidence: 0.58, tier: 'PASS' }]);
      delete require.cache[require.resolve('../lib/mlb')];
      const { getLiveKalshiQuotesForGames } = require('../lib/mlb');
      return getLiveKalshiQuotesForGames([{ gamePk: 555 }]).then((res) => {
        assert.equal(res.fullGameByGamePk.get(555).kalshiPickTeam, 'Home Team');
        assert.equal(res.f5ByGamePk.get(555).kalshiPickTeam, 'Away Team');
      });
    });
  } finally { global.fetch = originalFetch; }
});
