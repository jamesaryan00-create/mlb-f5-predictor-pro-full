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

// Human-readable labels for the full-game model's feature keys (data/full-game-model.json's
// featureNames), used to render the "why" explanation without a raw stat dump. Every feature the
// model actually uses must have an entry here -- topFeatureContributions() falls back to the raw
// key (rather than throwing) if a future feature is added without a label, so a label gap degrades
// gracefully instead of breaking the pick display.
const FEATURE_LABELS = {
  homeWinPctDiff: 'Season win% edge',
  homeFullRunDiff: 'Season run differential edge',
  homeF5WinPctDiff: 'First-5-innings win% edge',
  homeF5RunDiff: 'First-5-innings run differential edge',
  homeLateRunDiff: 'Late-inning (6-9) run differential edge',
  homeRecentFullRunDiff: 'Recent full-game run differential (form)',
  homePitchingFullRunDiff: 'Season pitching run-prevention edge',
  homeRecentRunDiff: "Recent form (F5 run differential)",
  homePitchingRunDiff: 'First-5 pitching run-prevention edge',
  homeParkFactor: 'Home park factor',
  homeRestDiff: 'Rest-days edge',
  homePitcherWhipDiff: 'Starting pitcher WHIP edge',
  homePitcherFipDiff: 'Starting pitcher FIP edge'
};

// Pure function: given the exact features/model used for a pick, returns the top-n features by
// |contribution to the logit|, matching probability()'s math exactly (weight * (value - mean) /
// scale). `side` is 'home' or 'away' -- the side the model actually picked -- so `favoredPick` can
// say whether each factor pushed toward or against the picked side (a positive contribution always
// favors HOME; it favors the picked side only when side === 'home').
function topFeatureContributions(features, model, n = 4, side = 'home') {
  const names = model?.featureNames;
  if (!Array.isArray(names) || !names.length || !features) return [];
  const f = { ...features };
  for (const key of ['homePitcherWhipDiff', 'homePitcherFipDiff']) if (f[key] === null) f[key] = 0;
  const rows = names
    .filter((name) => Number.isFinite(f[name]) && Number.isFinite(model.weights?.[name]) && Number.isFinite(model.featureMeans?.[name]) && Number.isFinite(model.featureScales?.[name]) && model.featureScales[name] > 0)
    .map((name) => {
      const contribution = model.weights[name] * (f[name] - model.featureMeans[name]) / model.featureScales[name];
      return {
        feature: name,
        label: FEATURE_LABELS[name] || name,
        contribution: Number(contribution.toFixed(4)),
        direction: (contribution >= 0) === (side === 'home') ? 'for' : 'against'
      };
    });
  rows.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return rows.slice(0, n);
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

module.exports = { PIPELINE_VERSION, loadFullGameModel, probability, forecast, topFeatureContributions, FEATURE_LABELS };
