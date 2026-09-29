const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');

// generatePicks() pulls live schedule/context/pitcher data through lib/mlb.js, lib/historical-f5.js
// and lib/pitcher-history.js. Those modules are mutated in place (module.exports properties) BEFORE
// lib/model-forward.js is first required in this process, so its top-level
// `const { getSchedule } = require('./mlb')`-style destructuring picks up the stubs instead of
// hitting the network. Each test file runs in its own process under `node --test`, so this mutation
// never leaks into other test files.
function withTempCwd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-gen-'));
  const prev = process.cwd();
  fs.mkdirSync(path.join(dir, 'data', 'model-forward'), { recursive: true });
  process.chdir(dir);
  return Promise.resolve().then(() => fn(dir)).finally(() => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true }); });
}

test('generatePicks() computes and stores topFactors on each recorded pick, from the same features/model used for the pick', async () => {
  await withTempCwd(async (dir) => {
    fs.copyFileSync(path.join(__dirname, '..', 'data', 'full-game-model.json'), path.join(dir, 'data', 'full-game-model.json'));
    fs.copyFileSync(path.join(__dirname, '..', 'data', 'model.json'), path.join(dir, 'data', 'model.json'));
    const fullGameModel = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'full-game-model.json'), 'utf8'));
    // Displace only homePitcherFipDiff from its mean so it's the unambiguous top contributor --
    // lets the test assert on a specific expected feature/label instead of just "length > 0".
    const features = { ...fullGameModel.featureMeans, homePitcherFipDiff: fullGameModel.featureMeans.homePitcherFipDiff + 1 };

    const gameDate = new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString();
    const scheduleGame = {
      gamePk: 555, officialDate: '2026-09-25', gameDate, status: 'Scheduled',
      home: { id: 1, name: 'Home Team', probablePitcher: { id: 11 } },
      away: { id: 2, name: 'Away Team', probablePitcher: { id: 22 } }
    };

    const mlb = require('../lib/mlb');
    const historicalF5 = require('../lib/historical-f5');
    const pitcherHistory = require('../lib/pitcher-history');
    const origGetSchedule = mlb.getSchedule, origContext = historicalF5.getLiveHistoricalContext,
      origFullVec = historicalF5.liveFullGameFeatureVector, origF5Vec = historicalF5.liveFeatureVector,
      origQuality = pitcherHistory.liveRollingPitcherQuality, origFetch = global.fetch;

    mlb.getSchedule = async () => [scheduleGame];
    historicalF5.getLiveHistoricalContext = async () => ({ throughDate: '2026-09-24' });
    historicalF5.liveFullGameFeatureVector = () => features;
    historicalF5.liveFeatureVector = () => null; // F5 secondary unavailable; only the full-game path matters here
    pitcherHistory.liveRollingPitcherQuality = async () => null;
    global.fetch = async (url) => {
      if (String(url).includes('schedule')) {
        return {
          ok: true, json: async () => ({ dates: [{ games: [{
            gamePk: 555, gameDate, status: { detailedState: 'Scheduled' },
            teams: { home: { probablePitcher: { id: 11 } }, away: { probablePitcher: { id: 22 } } }
          }] }] })
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    try {
      const { generatePicks } = require('../lib/model-forward');
      const res = await generatePicks('2026-09-25');
      assert.equal(res.skipped, false);
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'model-forward', 'picks-2026-09-25.json'), 'utf8'));
      const p = written.picks.find((x) => x.gamePk === 555);
      assert.ok(p.available, 'expected the pick to be recorded as available');
      assert.ok(Array.isArray(p.topFactors) && p.topFactors.length > 0, 'expected topFactors to be stored on the recorded pick');
      assert.equal(p.topFactors[0].feature, 'homePitcherFipDiff');
      assert.equal(p.topFactors[0].label, 'Starting pitcher FIP edge');
    } finally {
      mlb.getSchedule = origGetSchedule;
      historicalF5.getLiveHistoricalContext = origContext;
      historicalF5.liveFullGameFeatureVector = origFullVec;
      historicalF5.liveFeatureVector = origF5Vec;
      pitcherHistory.liveRollingPitcherQuality = origQuality;
      global.fetch = origFetch;
    }
  });
});
