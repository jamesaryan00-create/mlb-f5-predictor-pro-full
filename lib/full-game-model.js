const fs = require('fs');
const path = require('path');

const PIPELINE_VERSION = 'full-game-history-v1';

function loadFullGameModel() {
  try {
    const model = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'full-game-model.json'), 'utf8'));
    return model.pipelineVersion === PIPELINE_VERSION ? model : null;
  } catch { return null; }
}

function probability(features, model = loadFullGameModel()) {
  const names = model?.featureNames;
  if (features) features = { ...features };
  for (const key of ['homePitcherWhipDiff', 'homePitcherFipDiff']) if (features?.[key] === null) features[key] = 0;
  if (!Array.isArray(names) || !names.length || !features || !Number.isFinite(model?.weights?.bias)) return null;
  if (!names.every((name) => Number.isFinite(features[name]) && Number.isFinite(model.weights[name]) && Number.isFinite(model.featureMeans[name]) && Number.isFinite(model.featureScales[name]) && model.featureScales[name] > 0)) return null;
  const z = names.reduce((sum, name) => sum + model.weights[name] * (features[name] - model.featureMeans[name]) / model.featureScales[name], model.weights.bias);
  const p = 1 / (1 + Math.exp(-z));
  return Number.isFinite(p) && p > 0 && p < 1 ? p : null;
}

function forecast(game, features, eligible = true, model = loadFullGameModel()) {
  const homeProbability = probability(features, model);
  if (!eligible || homeProbability === null) return { available: false, pick: null, opponent: null, confidence: null, homeProbability: null, awayProbability: null, modelVersion: model?.version || null };
  const side = homeProbability >= 0.5 ? 'home' : 'away';
  return {
    available: true,
    pick: game[side].name,
    opponent: game[side === 'home' ? 'away' : 'home'].name,
    side,
    confidence: Number((100 * Math.max(homeProbability, 1 - homeProbability)).toFixed(1)),
    homeProbability: Number((100 * homeProbability).toFixed(1)),
    awayProbability: Number((100 * (1 - homeProbability)).toFixed(1)),
    modelVersion: model.version,
    probabilityBasis: 'Full-game winner',
    historicalAccuracy: Number((100 * model.metrics.walkForwardAccuracy).toFixed(2)),
    note: 'Full-game historical model. F5 strength is an input; no betting or profitability claim.'
  };
}

module.exports = { PIPELINE_VERSION, loadFullGameModel, probability, forecast };
