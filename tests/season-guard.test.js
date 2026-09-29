const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { hasGamesOnDate, hasAnyGames } = require('../lib/season-guard');

function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'season-guard-'));
  const prev = process.cwd();
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  process.chdir(dir);
  return Promise.resolve().then(() => fn(dir)).finally(() => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); });
}

// Mocks global.fetch the same way tests/model-forward-schedule.test.js does, so lib/mlb.js's
// getSchedule() (which hasGamesOnDate calls by default) never makes a real network call.
async function withMockedSchedule(gamesByDate, fn) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const m = /date=([^&]+)/.exec(String(url));
    const date = m ? decodeURIComponent(m[1]) : null;
    const games = gamesByDate[date] || [];
    return { ok: true, json: async () => ({ dates: games.length ? [{ games }] : [] }) };
  };
  try { return await withTempCwd(fn); } finally { global.fetch = orig; }
}

const regGame = (o = {}) => ({ gamePk: 1, officialDate: '2026-09-23', gameDate: '2026-09-23T23:05:00Z', status: { detailedState: 'Scheduled' }, teams: { home: { team: { id: 1, name: 'H' } }, away: { team: { id: 2, name: 'A' } } }, ...o });

test('hasGamesOnDate returns false for a genuinely gameless day (schedule API returns zero games)', async () => {
  await withMockedSchedule({}, async () => {
    assert.equal(await hasGamesOnDate('2026-12-01'), false);
  });
});

test('hasGamesOnDate returns true for a regular-season day with games', async () => {
  await withMockedSchedule({ '2026-09-23': [regGame()] }, async () => {
    assert.equal(await hasGamesOnDate('2026-09-23'), true);
  });
});

test('hasGamesOnDate returns true for a postseason-only day (gameType D/W is not filtered out)', async () => {
  // getSchedule() does not restrict by gameType, so a postseason game (e.g. World Series, 'W')
  // must be treated as "has games" exactly like a regular-season ('R') game.
  await withMockedSchedule({ '2026-10-28': [regGame({ gamePk: 999, officialDate: '2026-10-28', gameDate: '2026-10-28T23:05:00Z' })] }, async () => {
    assert.equal(await hasGamesOnDate('2026-10-28'), true);
  });
});

test('hasGamesOnDate accepts an injectable scheduleFetcher instead of hitting lib/mlb.js', async () => {
  const fetcher = async (date) => (date === '2026-09-23' ? [regGame()] : []);
  assert.equal(await hasGamesOnDate('2026-09-23', { scheduleFetcher: fetcher }), true);
  assert.equal(await hasGamesOnDate('2026-12-01', { scheduleFetcher: fetcher }), false);
});

test('hasAnyGames short-circuits true if any date in the list has games', async () => {
  const fetcher = async (date) => (date === '2026-09-24' ? [regGame()] : []);
  assert.equal(await hasAnyGames(['2026-12-01', '2026-09-24'], { scheduleFetcher: fetcher }), true);
  assert.equal(await hasAnyGames(['2026-12-01', '2026-12-02'], { scheduleFetcher: fetcher }), false);
});
