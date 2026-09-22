const fs = require('fs');
const path = require('path');
const { fetchSeasonGames, buildFeatureRows, clamp } = require('../lib/historical-f5');

const START_SEASON = Number(process.env.HISTORY_START_SEASON || 2010);
const CURRENT_SEASON = Number(process.env.HISTORY_END_SEASON || new Date().getFullYear());
const TODAY = process.env.HISTORY_THROUGH_DATE || new Date().toISOString().slice(0, 10);
const EPOCHS = Number(process.env.ML_EPOCHS || 180);
const FEATURES = [
  'homeWinPctDiff', 'homeFullRunDiff', 'homeF5WinPctDiff', 'homeF5RunDiff',
  'homeLateRunDiff', 'homeRecentFullRunDiff', 'homePitchingFullRunDiff',
  'homeRecentRunDiff', 'homePitchingRunDiff', 'homeParkFactor', 'homeRestDiff',
  'homePitcherWhipDiff', 'homePitcherFipDiff'
];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const value = (row, name) => Number.isFinite(row.fullGameFeatures?.[name]) ? row.fullGameFeatures[name] : 0;

function train(rows, epochs = EPOCHS) {
  const means = {}, scales = {};
  for (const f of FEATURES) {
    const xs = rows.map((r) => value(r, f));
    means[f] = mean(xs);
    scales[f] = Math.sqrt(mean(xs.map((x) => (x - means[f]) ** 2))) || 1;
  }
  let bias = 0, weights = FEATURES.map(() => 0);
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = FEATURES.map(() => 0); let gb = 0;
    const rate = 0.12 / (1 + epoch / 400);
    for (const row of rows) {
      const x = FEATURES.map((f) => (value(row, f) - means[f]) / scales[f]);
      const error = sigmoid(bias + weights.reduce((s, w, i) => s + w * x[i], 0)) - row.fullTarget;
      gb += error; for (let i = 0; i < weights.length; i++) gradient[i] += error * x[i];
    }
    bias -= rate * gb / rows.length;
    for (let i = 0; i < weights.length; i++) weights[i] -= rate * (gradient[i] / rows.length + 0.002 * weights[i]);
  }
  return { bias, weights: Object.fromEntries(FEATURES.map((f, i) => [f, weights[i]])), means, scales };
}

function probability(model, row) {
  return sigmoid(FEATURES.reduce((z, f) => z + model.weights[f] * (value(row, f) - model.means[f]) / model.scales[f], model.bias));
}

function score(model, rows) {
  const picks = rows.map((row) => {
    const homeProbability = probability(model, row);
    const side = homeProbability >= 0.5 ? 'home' : 'away';
    const result = row.fullResult === side ? 'win' : 'loss';
    return { date: row.date, gamePk: row.gamePk, homeTeam: row.homeTeam, awayTeam: row.awayTeam, pick: side === 'home' ? row.homeTeam : row.awayTeam, side, probability: Math.max(homeProbability, 1 - homeProbability), homeProbability, result, homeFinal: row.homeFinal, awayFinal: row.awayFinal };
  });
  const wins = picks.filter((p) => p.result === 'win').length;
  const losses = picks.length - wins;
  const brier = mean(rows.map((r, i) => (picks[i].homeProbability - r.fullTarget) ** 2));
  const logLoss = -mean(rows.map((r, i) => r.fullTarget * Math.log(clamp(picks[i].homeProbability, 1e-9, 1 - 1e-9)) + (1-r.fullTarget) * Math.log(clamp(1-picks[i].homeProbability, 1e-9, 1-1e-9))));
  return { picks, metrics: { games: picks.length, wins, losses, accuracy: picks.length ? wins / picks.length : null, brier, logLoss } };
}

async function main() {
  const bySeason = {}, all = [];
  for (let season = START_SEASON; season <= CURRENT_SEASON; season++) {
    const games = await fetchSeasonGames(season, { throughDate: season === CURRENT_SEASON ? TODAY : null, ttl: 0 });
    const rows = buildFeatureRows(games).rows.filter((r) => r.fullTarget === 0 || r.fullTarget === 1);
    bySeason[season] = rows; all.push(...rows); console.log(`${season}: ${rows.length}`);
  }
  const evaluation = [], yearly = [];
  for (let season = Math.max(START_SEASON + 3, Number(process.env.BACKTEST_START_SEASON || START_SEASON + 3)); season <= CURRENT_SEASON; season++) {
    const training = all.filter((r) => r.season < season), testing = bySeason[season] || [];
    if (!training.length || !testing.length) continue;
    const scored = score(train(training, Math.max(100, Math.round(EPOCHS * 0.65))), testing);
    evaluation.push(...scored.picks); yearly.push({ season, ...scored.metrics });
    console.log(`evaluate ${season}: ${scored.metrics.wins}-${scored.metrics.losses} (${(100 * scored.metrics.accuracy).toFixed(2)}%)`);
  }
  const final = train(all);
  const evaluationWins = evaluation.filter((p) => p.result === 'win').length;
  const artifact = {
    pipelineVersion: 'full-game-history-v1', version: `full-game-history-v1-${START_SEASON}-${CURRENT_SEASON}`,
    trainedAt: new Date().toISOString(), throughDate: TODAY, target: 'Full-game winner',
    featureNames: FEATURES, featureMeans: final.means, featureScales: final.scales,
    weights: { bias: final.bias, ...final.weights },
    metrics: { trainingGames: all.length, walkForwardGames: evaluation.length, walkForwardWins: evaluationWins, walkForwardLosses: evaluation.length - evaluationWins, walkForwardAccuracy: evaluation.length ? evaluationWins / evaluation.length : null },
    methodology: 'Season-by-season expanding-window evaluation. Features use only games completed before the prediction date; same-day results are excluded.'
  };
  const output = path.join(process.cwd(), 'data');
  fs.writeFileSync(path.join(output, 'full-game-model.json'), JSON.stringify(artifact, null, 2));
  fs.writeFileSync(path.join(output, 'full-game-backtest.json'), JSON.stringify({ generatedAt: artifact.trainedAt, methodology: artifact.methodology, overall: artifact.metrics, bySeason: yearly }, null, 2));
  fs.writeFileSync(path.join(output, 'full-game-backtest-picks.json'), JSON.stringify(evaluation));
  console.log(`Full-game walk-forward: ${evaluationWins}-${evaluation.length-evaluationWins} (${(100*artifact.metrics.walkForwardAccuracy).toFixed(2)}%)`);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
module.exports = { FEATURES, train, probability, score };
