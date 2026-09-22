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
test('flaggedF5Alternative appears only when F5 edge clears full-game edge by the documented margin', () => {
  const game = {gamePk:1, status:'Scheduled',gameDate:new Date(Date.now()+3600000).toISOString(), home:{id:1,name:'Home'},away:{id:2,name:'Away'}};
  const fullGameModel = require('../data/full-game-model.json');
  const fgFeatures = Object.fromEntries(fullGameModel.featureNames.map(n => [n, fullGameModel.featureMeans[n]]));
  const key = model.featureNames[0];
  const extremeF5 = {...features, [key]: model.featureMeans[key] + 10*model.featureScales[key]};
  const withFlag = calculateGamePrediction(game,{historicalFeatures:extremeF5, historicalFullGameFeatures: fgFeatures},null,null);
  assert.ok(withFlag.flaggedF5Alternative);
  assert.equal(withFlag.flaggedF5Alternative.pick, withFlag.f5Prediction.pick);
  assert.ok(withFlag.flaggedF5Alternative.edge >= withFlag.flaggedF5Alternative.fullGameEdge + 4);
  // full-game pick itself is unchanged/not overwritten by the flag
  assert.equal(withFlag.prediction.pick, withFlag.fullGamePrediction.pick);

  const noFlag = calculateGamePrediction(game,{historicalFeatures:features, historicalFullGameFeatures: fgFeatures},null,null);
  assert.equal(noFlag.flaggedF5Alternative, null);
  assert.equal(noFlag.prediction.flaggedF5Alternative, null);
});
test('the primary actionable prediction.pick is the full-game model, not F5', () => {
  const game = {gamePk:1, status:'Scheduled',gameDate:new Date(Date.now()+3600000).toISOString(), home:{id:1,name:'Home'},away:{id:2,name:'Away'}};
  const fullGameModel = require('../data/full-game-model.json');
  const fgFeatures = Object.fromEntries(fullGameModel.featureNames.map(n => [n, fullGameModel.featureMeans[n]]));
  const inputs = { historicalFeatures:features, historicalFullGameFeatures: fgFeatures };
  const base = calculateGamePrediction(game,inputs,null,null);
  assert.equal(base.prediction.pick, base.fullGamePrediction.pick);
  assert.equal(base.prediction.confidence, base.fullGamePrediction.confidence);
  assert.equal(base.prediction.pipelineVersion, 'full-game-primary-v1');
});
test('forecast uses absolute UTC instants, crosses midnight and rejects missing data', () => {
  const hourly = { time:[Date.parse('2026-09-15T00:00:00Z')/1000],temperature_2m:[70],wind_speed_10m:[0],precipitation_probability:[0] };
  assert.equal(selectWeatherHourly(hourly,'2026-09-14T17:10:00-07:00').temperature,70);
  assert.equal(selectWeatherHourly(hourly,'2026-09-14T19:00:00Z').available,false);
  assert.equal(selectWeatherHourly({...hourly,temperature_2m:[null]},'2026-09-15T00:00:00Z').available,false);
});
