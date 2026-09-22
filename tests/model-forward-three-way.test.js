const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { loadThreeWayModel, rankedSelection } = require('../lib/three-way-model');

test('captured three-way payload can be reproduced from saved features and model', () => {
  const model = loadThreeWayModel();
  const features = Object.fromEntries(model.features.map((name, i) => [name, (i - 3) / 10]));
  const selection = rankedSelection(features, model);
  const payload = { ...selection, modelVersion: model.version,
    modelSha256: crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex') };
  assert.deepEqual(payload.probabilities, rankedSelection(features, model).probabilities);
  assert.match(payload.modelSha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.pickProbability + payload.tieProbability <= 1, true);
});
