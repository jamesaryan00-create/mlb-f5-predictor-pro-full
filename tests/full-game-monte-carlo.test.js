const test = require('node:test');
const assert = require('node:assert/strict');
const { simulate, simulateV2, forecast, forecastV2 } = require('../lib/full-game-monte-carlo');
const calibration = require('../data/full-game-mc-calibration.json');
const { snapshot } = require('../lib/live-bullpen-quality');

test('full-game Monte Carlo is deterministic, exhaustive and favors the higher run rate', () => {
  const inputs = { homeEarlyRuns: 3, awayEarlyRuns: 1, homeLateRuns: 2, awayLateRuns: 1 };
  const a = simulate(inputs, { simulations: 5000, seed: 42 });
  const b = simulate(inputs, { simulations: 5000, seed: 42 });
  assert.deepEqual(a, b);
  assert.equal(a.homeProbability + a.awayProbability, 1);
  assert.ok(a.homeProbability > 0.7);
  assert.equal(forecast({ home: { name: 'H' }, away: { name: 'A' } }, inputs, { simulations: 1000, seed: 1 }).pick, 'H');
  assert.equal(simulate({ ...inputs, homeLateRuns: null }), null);
});
test('v2 bullpen quality changes only the opponent late-run distribution',()=>{
 const inputs={homeEarlyRuns:2,awayEarlyRuns:2,homeLateRuns:2,awayLateRuns:2};
 const elite={tiers:Array.from({length:6},()=>({available:true,runMultiplier:.6}))};
 const poor={tiers:Array.from({length:6},()=>({available:true,runMultiplier:1.4}))};
 const a=simulateV2(inputs,{home:elite,away:poor},{simulations:10000,seed:9});
 assert.ok(a.awayProbability<a.homeProbability);
 assert.match(a.methodology,/reliever quality/);
});
test('live bullpen snapshot excludes the target date and V2 fails closed without both teams', () => {
  const before = Math.floor(Date.parse('2026-09-21T12:00:00Z') / 86400000);
  const row = (day) => ({ pitcher: 42, day, outs: 3, pitches: 12, h: 0, bb: 0, hbp: 0, hr: 0, k: 2 });
  const old = snapshot([row(before), row(before + 1)], '2026-09-22');
  const expected = snapshot([row(before)], '2026-09-22');
  assert.deepEqual(old, expected);
  assert.equal(forecastV2({home:{name:'H'},away:{name:'A'}},{homeEarlyRuns:2,awayEarlyRuns:2,homeLateRuns:2,awayLateRuns:2},{home:old,away:null}).available,false);
  assert.ok(calibration.extraInningHomeWinProbability > 0 && calibration.extraInningHomeWinProbability < 1);
  assert.ok(calibration.counts.tiedAfterNine >= 300);
});
