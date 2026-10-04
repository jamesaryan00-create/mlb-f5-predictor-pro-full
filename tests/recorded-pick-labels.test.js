const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

async function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-recorded-label-'));
  const prev = process.cwd();
  fs.mkdirSync(path.join(dir, 'data', 'model-forward'), { recursive: true });
  process.chdir(dir);
  try { return await fn(dir); } finally { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); }
}
const write = (dir, name, obj) => fs.writeFileSync(path.join(dir, 'data', 'model-forward', name), JSON.stringify(obj));
const load = () => { delete require.cache[require.resolve('../lib/mlb')]; return require('../lib/mlb'); };

test('kalshi-primary picks keep their own label and grade via fgStatus (not collapsed to f5-legacy)', async () => {
  await withTempCwd(async (dir) => {
    write(dir, 'picks-2026-10-03.json', { trackedModel: 'kalshi-primary', picks: [{ gamePk: 1, available: true, pickTeam: 'Milwaukee Brewers', pickSide: 'HOME', confidence: 0.645 }] });
    write(dir, 'grades-2026-10-03.json', { results: [{ gamePk: 1, status: 'excluded', fgStatus: 'graded', result: 'HOME', win: true, tie: false, finalHome: 3, finalAway: 2 }] });
    const { getRecordedPickAndResult } = load();
    const r = getRecordedPickAndResult(1, '2026-10-03');
    assert.equal(r.recordedPick.trackedModel, 'kalshi-primary');
    assert.equal(r.recordedResult.win, true);
    assert.equal(r.recordedResult.finalHome, 3);
  });
});

test('a game with no pick on a tracked day explains why instead of showing nothing', async () => {
  await withTempCwd(async (dir) => {
    write(dir, 'picks-2026-10-03.json', { trackedModel: 'kalshi-primary', picks: [{ gamePk: 1, available: true, pickTeam: 'X', pickSide: 'HOME', confidence: 0.6 }] });
    const { getRecordedPickAndResult } = load();
    const r = getRecordedPickAndResult(2, '2026-10-03');
    assert.equal(r.recordedPick, null);
    assert.match(r.noPickNote, /not captured|No pregame Kalshi price was captured/i);
  });
});

test('a day with no picks file at all has no note (tracking never ran), never an error', async () => {
  await withTempCwd(async () => {
    const { getRecordedPickAndResult } = load();
    const r = getRecordedPickAndResult(2, '2026-10-03');
    assert.equal(r.recordedPick, null);
    assert.ok(!r.noPickNote);
  });
});
