const test = require('node:test');
const assert = require('node:assert/strict');
const { mlProbability, calculateGamePrediction, selectWeatherHourly } = require('../lib/mlb');
const model = require('../data/model.json');
const features = Object.fromEntries(model.featureNames.map(n => [n, model.featureMeans[n]]));
test('inference rejects absent/nonfinite features and invalid scaling', () => {
  assert.ok(mlProbability(features) > 0);
  for (const value of [undefined, null, NaN, Infinity, '0']) assert.equal(mlProbability({...features, homeRestDiff:value}), null);
  assert.equal(mlProbability(features, {...model, featureScales:{...model.featureScales,homeRestDiff:0}}),null);
});
test('F5 pick/confidence are still computed but exposed under f5Prediction, not prediction', () => {
  const game = {gamePk:1, status:'Scheduled',gameDate:new Date(Date.now()+3600000).toISOString(), home:{id:1,name:'Home'},away:{id:2,name:'Away'}};
  const inputs = { historicalFeatures:features };
  const base = calculateGamePrediction(game,inputs,null,null);
  assert.equal(base.f5Prediction.pick,mlProbability(features)>=.5?'Home':'Away');
  assert.equal(base.f5Prediction.confidence,Number((Math.max(mlProbability(features),1-mlProbability(features))*100).toFixed(1)));
  const changed = calculateGamePrediction(game,{...inputs,homePitcher:{era:999},teamRankingsF5:{available:true,rows:{}}},null,null);
  assert.deepEqual(changed.f5Prediction,base.f5Prediction);
  assert.equal(base.prediction.playable,false);assert.equal(base.prediction.estimatedEV,null);
  assert.equal(calculateGamePrediction({...game,status:'Final'},inputs,null,null).f5Prediction.pick,null);
});
test('flaggedF5Alternative appears only when F5 edge clears full-game edge by the documented margin (F5 secondary flag, independent of Kalshi availability)', () => {
  const game = {gamePk:1, status:'Scheduled',gameDate:new Date(Date.now()+3600000).toISOString(), home:{id:1,name:'Home'},away:{id:2,name:'Away'}};
  const fullGameModel = require('../data/full-game-model.json');
  const fgFeatures = Object.fromEntries(fullGameModel.featureNames.map(n => [n, fullGameModel.featureMeans[n]]));
  const key = model.featureNames[0];
  const extremeF5 = {...features, [key]: model.featureMeans[key] + 10*model.featureScales[key]};
  const withFlag = calculateGamePrediction(game,{historicalFeatures:extremeF5, historicalFullGameFeatures: fgFeatures},null,null);
  assert.ok(withFlag.flaggedF5Alternative);
  assert.equal(withFlag.flaggedF5Alternative.pick, withFlag.f5Prediction.pick);
  assert.ok(withFlag.flaggedF5Alternative.edge >= withFlag.flaggedF5Alternative.fullGameEdge + 4);
  // The flag is purely informational and never appears as prediction.pick itself.
  assert.equal(withFlag.prediction.flaggedF5Alternative.pick, withFlag.flaggedF5Alternative.pick);

  const noFlag = calculateGamePrediction(game,{historicalFeatures:features, historicalFullGameFeatures: fgFeatures},null,null);
  assert.equal(noFlag.flaggedF5Alternative, null);
  assert.equal(noFlag.prediction.flaggedF5Alternative, null);
});
test('FEATURE-WISHLIST.md #41: prediction.pick is driven by the live Kalshi full-game price, not either model', () => {
  const game = {gamePk:1, status:'Scheduled',gameDate:new Date(Date.now()+3600000).toISOString(), home:{id:1,name:'Home'},away:{id:2,name:'Away'}};
  const fullGameModel = require('../data/full-game-model.json');
  const fgFeatures = Object.fromEntries(fullGameModel.featureNames.map(n => [n, fullGameModel.featureMeans[n]]));
  const inputs = { historicalFeatures:features, historicalFullGameFeatures: fgFeatures };

  // No usable Kalshi price for this game: the pick is plainly unavailable, not silently filled in
  // from either model, and nothing crashes.
  const noKalshi = calculateGamePrediction(game,inputs,null,null);
  assert.equal(noKalshi.kalshiPrimaryFullGame.available, false);
  assert.equal(noKalshi.prediction.pick, null);
  assert.equal(noKalshi.prediction.action, 'UNAVAILABLE');
  assert.match(noKalshi.kalshiPrimaryFullGame.reason, /no live kalshi price/i);
  // Our full-game model's own pick is still computed and exposed, just not the driver.
  assert.ok(noKalshi.fullGamePrediction.available);
  assert.equal(noKalshi.kalshiPrimaryFullGame.modelPick, noKalshi.fullGamePrediction.pick);

  // A usable Kalshi price picks the away side at 61%; our full-game model (by construction, mean
  // features) is agnostic/near 50-50 and may land on either side -- this test only asserts the
  // PRIMARY pick follows Kalshi's side, with our model surfaced as an agree/disagree flag.
  const kalshiRows = { fullGame: { kalshiPickSide: 'AWAY', kalshiPickTeam: 'Away', kalshiConfidence: 0.61, tier: 'PLAY', quoteTime: '2026-09-30T12:00:00Z' }, f5: null };
  const withKalshi = calculateGamePrediction(game, inputs, null, null, kalshiRows);
  assert.equal(withKalshi.prediction.pick, 'Away');
  assert.equal(withKalshi.prediction.confidence, 61);
  assert.equal(withKalshi.prediction.action, 'KALSHI');
  assert.equal(withKalshi.kalshiPrimaryFullGame.available, true);
  assert.equal(withKalshi.kalshiPrimaryFullGame.side, 'away');
  assert.equal(typeof withKalshi.kalshiPrimaryFullGame.modelAgrees, 'boolean');
  assert.equal(withKalshi.kalshiPrimaryFullGame.modelAgrees, withKalshi.fullGamePrediction.side === 'away');
  assert.equal(withKalshi.prediction.pipelineVersion, 'kalshi-primary-v1');

  // F5 Kalshi price is separately unavailable here (thin liquidity is the expected common case) --
  // must not crash and must not borrow the full-game Kalshi price.
  assert.equal(withKalshi.kalshiPrimaryF5.available, false);
});
test('forecast uses absolute UTC instants, crosses midnight and rejects missing data', () => {
  const hourly = { time:[Date.parse('2026-09-15T00:00:00Z')/1000],temperature_2m:[70],wind_speed_10m:[0],precipitation_probability:[0] };
  assert.equal(selectWeatherHourly(hourly,'2026-09-14T17:10:00-07:00').temperature,70);
  assert.equal(selectWeatherHourly(hourly,'2026-09-14T19:00:00Z').available,false);
  assert.equal(selectWeatherHourly({...hourly,temperature_2m:[null]},'2026-09-15T00:00:00Z').available,false);
});
