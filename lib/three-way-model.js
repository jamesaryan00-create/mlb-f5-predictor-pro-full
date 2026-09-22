const fs = require('fs');
const path = require('path');

function softmax(values) {
  const max = Math.max(...values);
  const exp = values.map((v) => Math.exp(v - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / total);
}

function loadThreeWayModel(file = path.join(process.cwd(), 'data', 'three-way-model.json')) {
  const model = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (model.type !== 'multinomial-logistic-standardized' || model.classes.length !== 3) {
    throw new Error('Unsupported three-way model artifact');
  }
  return model;
}

function threeWayProbability(features, model) {
  if (!features || !model) return null;
  const x = model.features.map((name) => {
    const value = Number(features[name] ?? 0);
    const scale = Number(model.scales[name]);
    return (value - Number(model.means[name])) / scale;
  });
  if (x.some((v) => !Number.isFinite(v))) return null;
  const scores = model.coefficients.map((weights, i) =>
    Number(model.intercepts[i]) + weights.reduce((sum, weight, j) => sum + weight * x[j], 0));
  const probabilities = softmax(scores);
  return Object.fromEntries(model.classes.map((name, i) => [name, probabilities[i]]));
}

function rankedSelection(features, model) {
  const probabilities = threeWayProbability(features, model);
  if (!probabilities) return null;
  const pickSide = probabilities.HOME >= probabilities.AWAY ? 'HOME' : 'AWAY';
  return { probabilities, pickSide, pickProbability: probabilities[pickSide], tieProbability: probabilities.TIE };
}

module.exports = { softmax, loadThreeWayModel, threeWayProbability, rankedSelection };
