const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFullGameModel, probability, forecast } = require('../lib/full-game-model');

test('full-game model produces a finite forecast and rejects incomplete inputs', () => {
  const model = loadFullGameModel();
  assert.ok(model);
  const features = Object.fromEntries(model.featureNames.map((name) => [name, model.featureMeans[name]]));
  const p = probability(features, model);
  assert.ok(p > 0 && p < 1);
  assert.equal(probability({ ...features, homeFullRunDiff: null }, model), null);
  const game = { home: { name: 'Home' }, away: { name: 'Away' } };
  const result = forecast(game, features, true, model);
  assert.equal(result.available, true);
  assert.equal(result.pick, p >= 0.5 ? 'Home' : 'Away');
  assert.equal(result.probabilityBasis, 'Full-game winner');
  assert.equal(forecast(game, features, false, model).pick, null);
});
