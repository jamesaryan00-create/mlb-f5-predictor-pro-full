const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { getRecordedDay } = require('../lib/recorded-day');

function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-recorded-day-'));
  const prev = process.cwd();
  fs.mkdirSync(path.join(dir, 'data', 'model-forward'), { recursive: true });
  process.chdir(dir);
  try { fn(path.join(dir, 'data', 'model-forward')); } finally { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); }
}
const pick = (o) => ({ gamePk: 1, away: 'Boston Red Sox', home: 'New York Yankees', awayId: 111, homeId: 147, officialDate: '2026-09-22', gameDate: '2026-09-22T23:00:00Z', available: true, pickSide: 'HOME', pickTeam: 'New York Yankees', confidence: 0.6, ...o });

test('missing files => empty games, no throw', () => withTempCwd(() => {
  const r = getRecordedDay('2026-09-22');
  assert.equal(r.historicalRecord, true); assert.deepEqual(r.games, []); assert.match(r.message, /No recorded picks/);
}));

test('full-game day: picks, results, scores, F5 secondary, excluded pick kept', () => withTempCwd((dir) => {
  fs.writeFileSync(path.join(dir, 'picks-2026-09-22.json'), JSON.stringify({ trackedModel: 'full-game', picks: [
    pick({ f5PickTeam: 'Boston Red Sox', f5PickSide: 'AWAY', f5Confidence: 0.55 }), pick({ gamePk: 2, available: false })] }));
  fs.writeFileSync(path.join(dir, 'grades-2026-09-22.json'), JSON.stringify({ results: [
    { gamePk: 1, status: 'graded', result: 'AWAY', win: false, tie: false, finalHome: 2, finalAway: 4, f5Result: 'TIE', f5Win: false, f5Tie: true }] }));
  const r = getRecordedDay('2026-09-22');
  assert.equal(r.games.length, 2);
  const g = r.games[0];
  assert.equal(g.status, 'Final'); assert.equal(g.home.abbreviation.length > 0, true);
  assert.equal(g.recordedPick.trackedModel, 'full-game'); assert.equal(g.recordedPick.confidence, 60);
  assert.equal(g.recordedResult.finalHome, 2); assert.equal(g.recordedPick.f5Pick.pick, 'Boston Red Sox'); assert.equal(g.recordedResult.f5Tie, true);
  assert.equal(r.games[1].recordedExcluded, true); assert.equal(r.games[1].recordedPick, null);
  assert.equal(r.summary.primary.losses, 1); assert.equal(r.summary.excluded, 1); assert.equal(r.summary.f5Secondary.ties, 1);
}));

test('legacy file labeled f5-legacy, no F5 secondary summary', () => withTempCwd((dir) => {
  fs.writeFileSync(path.join(dir, 'picks-2026-09-21.json'), JSON.stringify({ picks: [pick({})] }));
  fs.writeFileSync(path.join(dir, 'grades-2026-09-21.json'), JSON.stringify({ results: [{ gamePk: 1, status: 'graded', result: 'TIE', win: false, tie: true }] }));
  const r = getRecordedDay('2026-09-21');
  assert.equal(r.games[0].recordedPick.trackedModel, 'f5-legacy'); assert.equal(r.summary.f5Secondary, null); assert.equal(r.summary.primary.ties, 1);
}));
