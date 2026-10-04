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

test('surfaces topFactors when present on the recorded pick', () => withTempCwd((dir) => {
  const topFactors = [{ feature: 'homeFullRunDiff', label: 'Season run differential edge', contribution: 0.09, direction: 'for' }];
  fs.writeFileSync(path.join(dir, 'picks-2026-09-22.json'), JSON.stringify({ trackedModel: 'full-game', picks: [pick({ topFactors })] }));
  const r = getRecordedDay('2026-09-22');
  assert.deepEqual(r.games[0].recordedPick.topFactors, topFactors);
}));

test('omits topFactors gracefully for a legacy picks file that predates the field, without crashing', () => withTempCwd((dir) => {
  fs.writeFileSync(path.join(dir, 'picks-2026-09-22.json'), JSON.stringify({ trackedModel: 'full-game', picks: [pick({})] }));
  const r = getRecordedDay('2026-09-22');
  assert.equal(r.games[0].recordedPick.topFactors, null);
}));

// FEATURE-WISHLIST.md #41: a kalshi-primary day labels itself distinctly from 'full-game' and
// 'f5-legacy', shows the model-agree flag (not the F5 model's own pick) as the full-game secondary,
// and reports the F5 market's own Kalshi-primary pick (f5Primary) separately, including the common
// case where it's simply unavailable (thin F5 liquidity).
test('kalshi-primary day: labels itself distinctly, shows modelAgree flag, and reports f5Primary (available and unavailable) separately from fullGame', () => withTempCwd((dir) => {
  fs.writeFileSync(path.join(dir, 'picks-2026-09-25.json'), JSON.stringify({ trackedModel: 'kalshi-primary', picks: [
    pick({ gamePk: 1, fgModelPickSide: 'AWAY', fgModelPickTeam: 'Boston Red Sox', fgModelConfidence: 0.52, fgModelAgreesWithKalshi: false,
      f5Available: true, f5PickSide: 'AWAY', f5PickTeam: 'Boston Red Sox', f5Confidence: 0.57,
      f5ModelPickSide: 'AWAY', f5ModelPickTeam: 'Boston Red Sox', f5ModelConfidence: 0.53, f5ModelAgreesWithKalshi: true }),
    pick({ gamePk: 2, f5Available: false, f5Reason: 'No usable live Kalshi price for the F5 market at capture time (F5 Kalshi liquidity is thin -- see FEATURE-WISHLIST.md #41)' })
  ] }));
  fs.writeFileSync(path.join(dir, 'grades-2026-09-25.json'), JSON.stringify({ results: [
    { gamePk: 1, fgStatus: 'graded', status: 'graded', result: 'HOME', win: true, tie: false, finalHome: 5, finalAway: 3, f5Status: 'graded', f5Result: 'AWAY', f5Win: true, f5Tie: false, f5Home: 3, f5Away: 2 },
    { gamePk: 2, fgStatus: 'graded', status: 'graded', result: 'HOME', win: true, tie: false, finalHome: 4, finalAway: 1, f5Status: 'excluded', f5Reason: 'No usable live Kalshi price for the F5 market at capture time' }
  ] }));
  const r = getRecordedDay('2026-09-25');
  assert.equal(r.summary.trackedModel, 'kalshi-primary');
  const [g1, g2] = r.games;
  assert.equal(g1.recordedPick.trackedModel, 'kalshi-primary');
  assert.equal(g1.recordedPick.modelAgree.side, 'AWAY');
  assert.equal(g1.recordedPick.modelAgree.agrees, false);
  assert.equal(g1.recordedPick.f5Pick, null, 'kalshi-primary must not populate the full-game-convention f5Pick field');
  assert.equal(g1.recordedPick.f5Primary.pick, 'Boston Red Sox');
  assert.equal(g1.recordedPick.f5Primary.modelAgree.agrees, true);
  assert.equal(g1.recordedResult.f5Result, 'AWAY');
  assert.equal(g2.recordedPick.f5Primary.available, false);
  assert.match(g2.recordedPick.f5Primary.reason, /thin/);
  assert.equal(r.summary.f5Secondary.wins, 1);
  assert.equal(r.summary.primary.wins, 2);
}));

test('F5-only captured pick and completed F5 remain visible before full-game grade', () => withTempCwd((dir) => {
  fs.writeFileSync(path.join(dir, 'picks-2026-09-22.json'), JSON.stringify({trackedModel:'kalshi-primary',picks:[pick({available:false,pickTeam:null,f5Available:true,f5PickTeam:'Boston Red Sox',f5Confidence:.6})]}));
  fs.writeFileSync(path.join(dir, 'grades-2026-09-22.json'), JSON.stringify({results:[{gamePk:1,fgStatus:'excluded',f5Status:'graded',f5Result:'TIE',f5Win:false,f5Tie:true}]}));
  const g=getRecordedDay('2026-09-22').games[0];
  assert.equal(g.recordedPick.pick,null);
  assert.equal(g.recordedPick.f5Primary.pick,'Boston Red Sox');
  assert.equal(g.recordedResult.f5Tie,true);
  assert.equal(g.recordedResult.win,null);
}));
