const test = require('node:test');
const assert = require('node:assert/strict');
const { loadFullGameModel, probability, forecast, topFeatureContributions } = require('../lib/full-game-model');

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

// Synthetic model with two features so ranking/sign/label math is checked against hand-computed
// expected contributions, independent of the real trained model's weights.
const SYN_MODEL = {
  featureNames: ['big', 'small'],
  featureMeans: { big: 0, small: 0 },
  featureScales: { big: 1, small: 1 },
  weights: { bias: 0, big: 2, small: 0.5 }
};

test('topFeatureContributions ranks by |contribution|, matches the exact logit formula, and labels direction relative to the picked side', () => {
  // big: 2 * (3 - 0) / 1 = 6 (positive => favors HOME). small: 0.5 * (-4 - 0) / 1 = -2 (negative => favors AWAY).
  const features = { big: 3, small: -4 };
  const homeSide = topFeatureContributions(features, SYN_MODEL, 4, 'home');
  assert.equal(homeSide.length, 2);
  assert.equal(homeSide[0].feature, 'big');
  assert.equal(homeSide[0].contribution, 6);
  assert.equal(homeSide[0].direction, 'for'); // positive contribution, home picked => for
  assert.equal(homeSide[1].feature, 'small');
  assert.equal(homeSide[1].contribution, -2);
  assert.equal(homeSide[1].direction, 'against'); // negative contribution, home picked => against

  const awaySide = topFeatureContributions(features, SYN_MODEL, 4, 'away');
  assert.equal(awaySide[0].direction, 'against'); // positive contribution now opposes the away pick
  assert.equal(awaySide[1].direction, 'for'); // negative contribution now favors the away pick
});

test('topFeatureContributions respects n and produces human-readable labels for known real-model features', () => {
  const model = loadFullGameModel();
  const features = { ...model.featureMeans, homePitcherFipDiff: model.featureMeans.homePitcherFipDiff + 1 };
  const top = topFeatureContributions(features, model, 3, 'home');
  assert.equal(top.length, 3);
  assert.ok(top.every((row) => typeof row.label === 'string' && row.label.length > 0));
  // Displacing only homePitcherFipDiff from its mean should make it the single largest contributor.
  assert.equal(top[0].feature, 'homePitcherFipDiff');
  assert.equal(top[0].label, 'Starting pitcher FIP edge');
});

test('topFeatureContributions returns [] gracefully for missing model/features rather than throwing', () => {
  assert.deepEqual(topFeatureContributions(null, SYN_MODEL), []);
  assert.deepEqual(topFeatureContributions({}, null), []);
});
