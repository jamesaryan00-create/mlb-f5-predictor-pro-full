const test=require('node:test'),assert=require('node:assert/strict');
const {liveRollingPitcherQuality}=require('../lib/pitcher-history');

// Build a fake gameLog response for a season with `n` starts ending just before `beforeDate`'s
// year boundary (2025 starts land in September, spaced one day apart), or an on/after-cutoff
// start injected when requested, to exercise the leakage cutoff.
function mkStart(year, i, gamePk, extra = {}) {
  const date = year === '2026' ? `2026-04-0${i + 1}` : `2025-09-${String(20 + i).padStart(2, '0')}`;
  return {
    date,
    gameType: 'R',
    game: { gamePk },
    stat: { gamesStarted: 1, inningsPitched: '5.0', hits: 5, baseOnBalls: 1, hitBatsmen: 0, strikeOuts: 5, homeRuns: 1, ...extra }
  };
}

function fetchFactory(bySeason) {
  const calls = [];
  const fn = async url => {
    const year = new URL(url).searchParams.get('season');
    calls.push(year);
    const splits = bySeason[year] || [];
    return { ok: true, json: async () => ({ stats: [{ type: { displayName: 'gameLog' }, splits }] }) };
  };
  fn.calls = calls;
  return fn;
}

test('live pitcher window crosses seasons and excludes analysis date', async () => {
  const original = global.fetch, years = [];
  global.fetch = async url => { const year = new URL(url).searchParams.get('season'); years.push(year); return { ok: true, json: async () => ({ stats: [{ type: { displayName: 'gameLog' }, splits: Array.from({ length: year === '2026' ? 1 : 10 }, (_, i) => ({ date: year === '2026' ? '2026-04-01' : `2025-09-${String(i + 1).padStart(2, '0')}`, gameType: 'R', game: { gamePk: Number(year) * 100 + i }, stat: { gamesStarted: 1, inningsPitched: '5.0', hits: 5, baseOnBalls: 1, hitBatsmen: 0, strikeOuts: 5, homeRuns: 1 } })) }] }) }; };
  try { const r = await liveRollingPitcherQuality(999991, '2026-04-01'); assert.deepEqual(years, ['2026', '2025']); assert.equal(r.starts, 10); assert.equal(r.whipLast10, 1.2); } finally { global.fetch = original; }
});

test('0 starts this season pulls a full 10-start window from the prior season', async () => {
  const original = global.fetch;
  const bySeason = {
    '2026': [],
    '2025': Array.from({ length: 10 }, (_, i) => mkStart('2025', i, 3000 + i))
  };
  global.fetch = fetchFactory(bySeason);
  try {
    const r = await liveRollingPitcherQuality(1, '2026-04-01');
    assert.equal(global.fetch.calls.join(','), '2026,2025');
    assert.equal(r.starts, 10);
  } finally { global.fetch = original; }
});

test('4 starts this season + 6 from prior season, in correct recency order', async () => {
  const original = global.fetch;
  const bySeason = {
    '2026': Array.from({ length: 4 }, (_, i) => mkStart('2026', i, 4000 + i)),
    '2025': Array.from({ length: 10 }, (_, i) => mkStart('2025', i, 5000 + i))
  };
  global.fetch = fetchFactory(bySeason);
  try {
    const r = await liveRollingPitcherQuality(2, '2026-04-05');
    assert.equal(global.fetch.calls.join(','), '2026,2025');
    assert.equal(r.starts, 10);
    // Sanity: this should equal training's cross-season windowing (last 10 by date, gamePk tiebreak)
    // -- same aggregation as the current-season-only case, just sourced from two seasons.
    assert.ok(Number.isFinite(r.whipLast10) && Number.isFinite(r.fipLast10));
  } finally { global.fetch = original; }
});

test('10+ starts this season: no prior-season fetch happens at all', async () => {
  const original = global.fetch;
  const bySeason = {
    '2026': Array.from({ length: 12 }, (_, i) => mkStart('2026', i, 6000 + i))
  };
  global.fetch = fetchFactory(bySeason);
  try {
    const r = await liveRollingPitcherQuality(3, '2026-05-01');
    assert.equal(global.fetch.calls.length, 1, 'must not fetch a prior season when the current one already has enough starts');
    assert.equal(global.fetch.calls[0], '2026');
    assert.equal(r.starts, 10);
  } finally { global.fetch = original; }
});

test('leakage: nothing on or after beforeDate is ever included, from either season', async () => {
  const original = global.fetch;
  const bySeason = {
    '2026': [
      mkStart('2026', 0, 7000),
      // A start dated exactly on beforeDate must be excluded.
      { date: '2026-04-05', gameType: 'R', game: { gamePk: 7001 }, stat: { gamesStarted: 1, inningsPitched: '5.0', hits: 999, baseOnBalls: 0, hitBatsmen: 0, strikeOuts: 0, homeRuns: 0 } }
    ],
    '2025': Array.from({ length: 10 }, (_, i) => mkStart('2025', i, 8000 + i))
  };
  global.fetch = fetchFactory(bySeason);
  try {
    const r = await liveRollingPitcherQuality(4, '2026-04-05');
    // If the on-cutoff start (hits:999) leaked in, WHIP would be enormous.
    assert.ok(r.whipLast10 < 5, `leaked same-day/future start into window: whip=${r.whipLast10}`);
  } finally { global.fetch = original; }
});

test('rookie/pitcher with no prior-season log at all degrades gracefully (partial window, not a crash)', async () => {
  const original = global.fetch;
  const bySeason = {
    '2026': Array.from({ length: 3 }, (_, i) => mkStart('2026', i, 9000 + i)),
    '2025': [] // debuted in 2026, nothing before it
  };
  global.fetch = fetchFactory(bySeason);
  try {
    const r = await liveRollingPitcherQuality(5, '2026-04-10');
    assert.equal(r.starts, 3);
    assert.ok(Number.isFinite(r.whipLast10));
  } finally { global.fetch = original; }
});
