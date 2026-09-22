const test = require('node:test');
const assert = require('node:assert/strict');
const { firstFiveRuns, buildFeatureRows } = require('../lib/historical-f5');
const { findOddsGame, sgoToLegacyOddsGame, classifyF5Decision, inningsToDecimal, calculateGamePrediction, getBullpenUsage } = require('../lib/mlb');
const game = (id = 1) => ({ gamePk: id, officialDate: '2026-09-12', gameDate: '2026-09-12T20:00:00Z', teams: { home: { team: { id: 1, name: 'Home' }, isWinner: true }, away: { team: { id: 2, name: 'Away' }, isWinner: false } }, linescore: { innings: Array.from({ length: 5 }, (_, i) => ({ num: i + 1, home: { runs: 1 }, away: { runs: 0 } })) } });
test('incomplete or repeated F5 innings are rejected; real zero runs accepted', () => {
  assert.deepEqual(firstFiveRuns(game()), { home: 5, away: 0 });
  const g = game(); delete g.linescore.innings[0].away.runs;
  assert.equal(firstFiveRuns(g), null);
  g.linescore.innings[0] = g.linescore.innings[1];
  assert.equal(firstFiveRuns(g), null);
});
test('duplicate games cannot enter their own history; conflicting records fail', () => {
  const g = game(); const later = game(2); later.gameDate = '2026-09-13T20:00:00Z'; later.officialDate = '2026-09-13';
  const result = buildFeatureRows([g, structuredClone(g), later]);
  assert.equal(result.rows.length, 2); assert.equal(result.states.get(1).games, 2);
  assert.equal(result.rows[0].features.homeF5RunDiff, 0);
  const conflict = structuredClone(g); conflict.linescore.innings[0].home.runs = 2;
  assert.throws(() => buildFeatureRows([g, conflict]), /Conflicting/);
});
test('odds require exact home/away and scheduled instant, with unique match', () => {
  const g = { home: { name: 'Home' }, away: { name: 'Away' }, gameDate: '2026-09-12T20:00:00Z' };
  const event = { home_team: 'Home', away_team: 'Away', commence_time: g.gameDate };
  const payload = (games) => ({ available: true, games });
  assert.equal(findOddsGame(payload([event]), g), event);
  assert.equal(findOddsGame(payload([{ ...event, commence_time: '2026-09-13T20:00:00Z' }]), g), null);
  assert.equal(findOddsGame(payload([{ ...event, home_team: 'Away', away_team: 'Home' }]), g), null);
  assert.equal(findOddsGame(payload([event, { ...event }]), g), null);
});
test('mismatched total lines are not averaged into an invented offer', () => {
  const e = { teams: { home: { name: 'Home' }, away: { name: 'Away' } }, odds: {
    'points-all-1h-ou-over': { byBookmaker: { book: { odds: -110, overUnder: 4 } } },
    'points-all-1h-ou-under': { byBookmaker: { book: { odds: -110, overUnder: 5 } } }
  } };
  assert.equal(sgoToLegacyOddsGame(e).bookmakers.length, 0);
  e.odds['points-all-1h-ou-under'].byBookmaker.book.overUnder = 4;
  assert.equal(sgoToLegacyOddsGame(e).bookmakers[0].markets[0].outcomes[0].point, 4);
});
test('missing confidence stays unavailable', () => {
  for (const value of [null, undefined, '']) {
    const result = classifyF5Decision({ confidence: value });
    assert.equal(result.confidence, null); assert.equal(result.historicalBucket, null); assert.equal(result.playable, false);
  }
});
test('innings use outs, not decimal notation', () => {
  assert.equal(inningsToDecimal('1.2'), 5 / 3);
  assert.equal(inningsToDecimal(null), null);
  assert.equal(inningsToDecimal('1.3'), null);
});
test('missing source statistics do not generate predictions', () => {
  const g = { gamePk: 1, home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } };
  const result = calculateGamePrediction(g, { homePitcher: {}, awayPitcher: {}, homeBio: {}, awayBio: {}, bullpen: {}, weather: {} }, null, null);
  assert.equal(result.prediction.pick, null); assert.equal(result.prediction.modelProbability, null); assert.equal(result.prediction.playable, false);
  assert.equal(result.home.rating, null);
});
test('failed bullpen fetch is unavailable, not zero innings', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw Error('provider offline'); };
  try { const result = await getBullpenUsage([1], '2026-09-12'); assert.equal(result[1].available, false); assert.equal(result[1].relieverInnings3d, null); }
  finally { global.fetch = original; }
});
test('same-day doubleheader results cannot enter later game features', () => {
 const g = game(), next = game(2); next.gameDate = '2026-09-12T23:00:00Z';
 const { rows, states } = buildFeatureRows([g,next]);
 assert.deepEqual(rows[0].features, rows[1].features);
 assert.equal(states.get(1).games,2);
});
test('postponed abstract-Final and resumed games are excluded', () => {
 const { completedRegularGames } = require('../lib/historical-f5');
 const final = { ...game(), gameType: 'R', status: { detailedState: 'Final', abstractGameState: 'Final' } };
 const ppd = { ...final, status: { detailedState: 'Postponed', abstractGameState: 'Final' } };
 assert.equal(completedRegularGames({ dates: [{ games: [ppd,final] }] }).length,1);
 assert.equal(completedRegularGames({ dates: [{ games: [{...final,resumeDate:'2026-09-13'}] }] }).length,0);
});
