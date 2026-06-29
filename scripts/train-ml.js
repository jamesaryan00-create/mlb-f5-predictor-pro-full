/*
  Trains a lightweight logistic regression model from the last two completed MLB seasons.
  Target: home team is leading or tied after 5 innings.
  Run: npm run train:ml
*/
const fs = require('fs');
const path = require('path');
const { fetchJson, num, clamp } = require('../lib/mlb');

const currentYear = new Date().getFullYear();
const seasons = (process.env.TRAIN_SEASONS || `${currentYear - 2},${currentYear - 1}`).split(',').map(Number);

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function emptyState() { return { games: 0, wins: 0, runs: 0, runsAllowed: 0, f5Runs: 0, f5Allowed: 0, recent: [] }; }
function stateFeatures(home, away) {
  const hwp = home.games ? home.wins / home.games : 0.5;
  const awp = away.games ? away.wins / away.games : 0.5;
  const hf5 = home.games ? (home.f5Runs - home.f5Allowed) / home.games : 0;
  const af5 = away.games ? (away.f5Runs - away.f5Allowed) / away.games : 0;
  const hr = home.recent.length ? home.recent.reduce((a, b) => a + b, 0) / home.recent.length : 0;
  const ar = away.recent.length ? away.recent.reduce((a, b) => a + b, 0) / away.recent.length : 0;
  const hp = home.games ? (home.runsAllowed / home.games) : 4.4;
  const ap = away.games ? (away.runsAllowed / away.games) : 4.4;
  return {
    homeWinPctDiff: hwp - awp,
    homeF5RunDiff: clamp((hf5 - af5) / 2.5, -2, 2),
    homeRecentRunDiff: clamp((hr - ar) / 6, -2, 2),
    homePitchingRunDiff: clamp((ap - hp) / 3, -2, 2),
    homeParkFactor: 0,
    homeRestDiff: 0,
  };
}
function updateState(state, runs, allowed, f5Runs, f5Allowed, won) {
  state.games += 1; state.wins += won ? 1 : 0; state.runs += runs; state.runsAllowed += allowed; state.f5Runs += f5Runs; state.f5Allowed += f5Allowed;
  state.recent.push(runs - allowed); if (state.recent.length > 10) state.recent.shift();
}
function f5Score(game) {
  const innings = game.linescore?.innings || [];
  let home = 0, away = 0;
  innings.slice(0, 5).forEach((inn) => { home += num(inn.home?.runs, 0); away += num(inn.away?.runs, 0); });
  return { home, away };
}

async function seasonGames(season) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R&hydrate=linescore`;
  const data = await fetchJson(url, { ttl: 1000 * 60 * 60 * 24 });
  return (data.dates || []).flatMap((d) => d.games || []).filter((g) => g.status?.abstractGameState === 'Final');
}

async function main() {
  const rows = [];
  for (const season of seasons) {
    console.log(`Fetching ${season} games...`);
    const teams = new Map();
    const games = await seasonGames(season);
    games.sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));
    for (const game of games) {
      const homeId = game.teams?.home?.team?.id;
      const awayId = game.teams?.away?.team?.id;
      if (!homeId || !awayId) continue;
      if (!teams.has(homeId)) teams.set(homeId, emptyState());
      if (!teams.has(awayId)) teams.set(awayId, emptyState());
      const homeState = teams.get(homeId), awayState = teams.get(awayId);
      const f5 = f5Score(game);
      const homeRuns = num(game.teams?.home?.score, 0), awayRuns = num(game.teams?.away?.score, 0);
      rows.push({ x: stateFeatures(homeState, awayState), y: f5.home >= f5.away ? 1 : 0 });
      updateState(homeState, homeRuns, awayRuns, f5.home, f5.away, homeRuns > awayRuns);
      updateState(awayState, awayRuns, homeRuns, f5.away, f5.home, awayRuns > homeRuns);
    }
  }

  const keys = ['homeWinPctDiff', 'homeF5RunDiff', 'homeRecentRunDiff', 'homePitchingRunDiff', 'homeParkFactor', 'homeRestDiff'];
  const w = Object.fromEntries(keys.map((k) => [k, 0]));
  let bias = 0;
  const lr = 0.045;
  const epochs = 900;
  for (let e = 0; e < epochs; e++) {
    for (const row of rows) {
      const z = bias + keys.reduce((sum, k) => sum + w[k] * row.x[k], 0);
      const p = sigmoid(z);
      const err = p - row.y;
      bias -= lr * err;
      keys.forEach((k) => { w[k] -= lr * err * row.x[k]; });
    }
  }
  let correct = 0, loss = 0;
  rows.forEach((row) => {
    const p = sigmoid(bias + keys.reduce((sum, k) => sum + w[k] * row.x[k], 0));
    if ((p >= 0.5 ? 1 : 0) === row.y) correct += 1;
    loss += -(row.y * Math.log(Math.max(p, 1e-9)) + (1 - row.y) * Math.log(Math.max(1 - p, 1e-9)));
  });
  const model = {
    version: `trained-${seasons.join('-')}`,
    trainedAt: new Date().toISOString(),
    trainingSeasons: seasons,
    type: 'logistic-regression',
    target: 'home team leads/ties after first 5 innings',
    weights: { bias: Number(bias.toFixed(6)), ...Object.fromEntries(keys.map((k) => [k, Number(w[k].toFixed(6))])) },
    metrics: { games: rows.length, accuracy: Number((correct / rows.length).toFixed(4)), logLoss: Number((loss / rows.length).toFixed(4)) },
  };
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'data', 'model.json'), JSON.stringify(model, null, 2));
  console.log(`Saved data/model.json with ${rows.length} games. Accuracy ${(model.metrics.accuracy * 100).toFixed(1)}%.`);
}
main().catch((err) => { console.error(err); process.exit(1); });
