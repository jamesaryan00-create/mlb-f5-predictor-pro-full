const test = require('node:test');
const assert = require('node:assert/strict');
const { loadThreeWayModel, threeWayProbability, rankedSelection } = require('../lib/three-way-model');

test('three-way probabilities are finite and sum to one', () => {
  const model = loadThreeWayModel();
  const features = Object.fromEntries(model.features.map((name) => [name, 0]));
  const p = threeWayProbability(features, model);
  assert.deepEqual(Object.keys(p), ['AWAY', 'TIE', 'HOME']);
  assert.ok(Object.values(p).every((value) => value > 0 && value < 1));
  assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 1e-12);
});

test('ranked selection uses direct lead probability and retains tie probability', () => {
  const model = loadThreeWayModel();
  const features = Object.fromEntries(model.features.map((name) => [name, 0]));
  const selection = rankedSelection(features, model);
  assert.equal(selection.pickProbability, selection.probabilities[selection.pickSide]);
  assert.equal(selection.tieProbability, selection.probabilities.TIE);
  assert.ok(selection.pickSide === 'HOME' || selection.pickSide === 'AWAY');
});
