const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { getRecordedPickAndResult } = require('../lib/mlb');

// getRecordedPickAndResult reads data/model-forward/picks-<date>.json and grades-<date>.json
// relative to process.cwd(), mirroring lib/model-forward.js's pickFile()/gradeFile() layout.
// Exercise it against a temp cwd so we never touch the real data/model-forward directory.
function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-recorded-pick-'));
  const prevCwd = process.cwd();
  fs.mkdirSync(path.join(dir, 'data', 'model-forward'), { recursive: true });
  process.chdir(dir);
  try { fn(dir); } finally { process.chdir(prevCwd); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('returns nulls when no pick file exists for the date (future date / before tracking started)', () => {
  withTempCwd(() => {
    const r = getRecordedPickAndResult(12345, '2026-09-22');
    assert.deepEqual(r, { recordedPick: null, recordedResult: null });
  });
});

test('returns nulls when gamePk or date is missing', () => {
  assert.deepEqual(getRecordedPickAndResult(null, '2026-09-22'), { recordedPick: null, recordedResult: null });
  assert.deepEqual(getRecordedPickAndResult(123, null), { recordedPick: null, recordedResult: null });
});

test('returns nulls when the pick for that gamePk exists but was excluded (available:false)', () => {
  withTempCwd((dir) => {
    const picksFile = path.join(dir, 'data', 'model-forward', 'picks-2026-09-22.json');
    fs.writeFileSync(picksFile, JSON.stringify({ picks: [{ gamePk: 555, available: false }] }));
    const r = getRecordedPickAndResult(555, '2026-09-22');
    assert.deepEqual(r, { recordedPick: null, recordedResult: null });
  });
});

test('surfaces the recorded pregame pick when a matching available pick exists', () => {
  withTempCwd((dir) => {
    const picksFile = path.join(dir, 'data', 'model-forward', 'picks-2026-09-22.json');
    fs.writeFileSync(picksFile, JSON.stringify({ picks: [
      { gamePk: 777, available: true, pickTeam: 'New York Yankees', pickSide: 'HOME', confidence: 0.634, capturedAt: '2026-09-22T17:00:00Z', model: { version: 'v9' } },
      { gamePk: 888, available: true, pickTeam: 'Boston Red Sox', pickSide: 'AWAY', confidence: 0.55 }
    ] }));
    const r = getRecordedPickAndResult(777, '2026-09-22');
    assert.equal(r.recordedPick.pick, 'New York Yankees');
    assert.equal(r.recordedPick.side, 'HOME');
    assert.equal(r.recordedPick.confidence, 63.4);
    assert.equal(r.recordedPick.capturedAt, '2026-09-22T17:00:00Z');
    assert.equal(r.recordedPick.modelVersion, 'v9');
    assert.equal(r.recordedResult, null);
  });
});

test('attaches the graded result once grading has run for the date', () => {
  withTempCwd((dir) => {
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'picks-2026-09-22.json'), JSON.stringify({ picks: [
      { gamePk: 777, available: true, pickTeam: 'New York Yankees', pickSide: 'HOME', confidence: 0.634 }
    ] }));
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'grades-2026-09-22.json'), JSON.stringify({ results: [
      { gamePk: 777, status: 'graded', result: 'HOME', win: true, tie: false }
    ] }));
    const r = getRecordedPickAndResult(777, '2026-09-22');
    assert.ok(r.recordedPick);
    assert.deepEqual(r.recordedResult, { result: 'HOME', win: true, tie: false, trackedModel: 'f5-legacy' });
  });
});

test('labels a recorded pick as f5-legacy when the picks file predates trackedModel, and as full-game when it is present', () => {
  withTempCwd((dir) => {
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'picks-2026-09-22.json'), JSON.stringify({ picks: [
      { gamePk: 111, available: true, pickTeam: 'Atlanta Braves', pickSide: 'HOME', confidence: 0.59 }
    ] })); // no trackedModel field: a pre-#31 legacy F5 record.
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'picks-2026-09-23.json'), JSON.stringify({ trackedModel: 'full-game', picks: [
      { gamePk: 222, available: true, pickTeam: 'Atlanta Braves', pickSide: 'HOME', confidence: 0.59 }
    ] }));
    assert.equal(getRecordedPickAndResult(111, '2026-09-22').recordedPick.trackedModel, 'f5-legacy');
    assert.equal(getRecordedPickAndResult(222, '2026-09-23').recordedPick.trackedModel, 'full-game');
  });
});

test('does not attach a result while grading is still pending for that game', () => {
  withTempCwd((dir) => {
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'picks-2026-09-22.json'), JSON.stringify({ picks: [
      { gamePk: 777, available: true, pickTeam: 'New York Yankees', pickSide: 'HOME', confidence: 0.634 }
    ] }));
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'grades-2026-09-22.json'), JSON.stringify({ results: [
      { gamePk: 777, status: 'pending' }
    ] }));
    const r = getRecordedPickAndResult(777, '2026-09-22');
    assert.ok(r.recordedPick);
    assert.equal(r.recordedResult, null);
  });
});

test('a corrupt/missing grades file is handled defensively, not thrown', () => {
  withTempCwd((dir) => {
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'picks-2026-09-22.json'), JSON.stringify({ picks: [
      { gamePk: 777, available: true, pickTeam: 'New York Yankees', pickSide: 'HOME', confidence: 0.634 }
    ] }));
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'grades-2026-09-22.json'), 'not json');
    assert.doesNotThrow(() => getRecordedPickAndResult(777, '2026-09-22'));
    const r = getRecordedPickAndResult(777, '2026-09-22');
    assert.equal(r.recordedResult, null);
  });
});

const { calculateGamePrediction } = require('../lib/mlb');

test('calculateGamePrediction attaches recordedPick/recordedResult only when the game is not eligible for a live forecast', () => {
  withTempCwd((dir) => {
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'picks-2026-09-22.json'), JSON.stringify({ picks: [
      { gamePk: 999, available: true, pickTeam: 'Chicago Cubs', pickSide: 'AWAY', confidence: 0.58 }
    ] }));
    fs.writeFileSync(path.join(dir, 'data', 'model-forward', 'grades-2026-09-22.json'), JSON.stringify({ results: [
      { gamePk: 999, status: 'graded', result: 'AWAY', win: true, tie: false }
    ] }));

    const baseGame = {
      gamePk: 999, officialDate: '2026-09-22',
      home: { id: 1, name: 'St. Louis Cardinals' }, away: { id: 2, name: 'Chicago Cubs' }, venue: 'Busch Stadium'
    };
    const inputs = { homeTeam: {}, awayTeam: {}, homePitcher: {}, awayPitcher: {}, homeBio: {}, awayBio: {}, homeSplits: {}, awaySplits: {}, bullpen: {}, liveBullpens: {}, weather: {}, injuries: {}, umpire: {}, teamRankingsF5: {}, historicalFeatures: null, historicalFullGameFeatures: null, fullGameSimulationInputs: null };

    // Finished game: not eligible for a live forecast -> recordedPick/recordedResult attached.
    const finished = calculateGamePrediction({ ...baseGame, status: 'Final', gameDate: '2026-09-22T20:00:00Z' }, inputs, null, { available: false, game: null });
    assert.ok(finished.recordedPick, 'expected recordedPick to be attached for a finished game');
    assert.equal(finished.recordedPick.pick, 'Chicago Cubs');
    assert.deepEqual(finished.recordedResult, { result: 'AWAY', win: true, tie: false, trackedModel: 'f5-legacy' });

    // Upcoming/eligible game: unchanged -- no recordedPick/recordedResult regardless of any file on disk.
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    const upcoming = calculateGamePrediction({ ...baseGame, status: 'Scheduled', gameDate: future }, inputs, null, { available: false, game: null });
    assert.equal(upcoming.recordedPick, null);
    assert.equal(upcoming.recordedResult, null);
  });
});
