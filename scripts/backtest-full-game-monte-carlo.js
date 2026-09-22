const fs = require('fs');
const path = require('path');
const { fetchSeasonGames, buildFeatureRows } = require('../lib/historical-f5');
const { simulate } = require('../lib/full-game-monte-carlo');

const START = Number(process.env.MC_START_SEASON || 2013);
const END = Number(process.env.HISTORY_END_SEASON || new Date().getFullYear());
const THROUGH = process.env.HISTORY_THROUGH_DATE || new Date().toISOString().slice(0, 10);
const SIMULATIONS = Number(process.env.MC_SIMULATIONS || 1200);
const logisticPicks = new Map(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/full-game-backtest-picks.json'))).map((p) => [p.gamePk, p]));

function resultAt(probability, target) { return (probability >= 0.5 ? 1 : 0) === target ? 'win' : 'loss'; }
function summarize(rows, key) {
  const wins = rows.filter((r) => r[key] === 'win').length;
  return { games: rows.length, wins, losses: rows.length - wins, accuracy: rows.length ? wins / rows.length : null };
}
function bestWeight(rows) {
  let best = { weight: 0, correct: -1 };
  for (let n = 0; n <= 20; n++) {
    const weight = n / 20;
    const correct = rows.filter((r) => resultAt(weight * r.logisticHomeProbability + (1-weight) * r.mcHomeProbability, r.target) === 'win').length;
    if (correct > best.correct) best = { weight, correct };
  }
  return best.weight;
}

async function main() {
  const rows = [];
  for (let season = START; season <= END; season++) {
    const games = await fetchSeasonGames(season, { throughDate: season === END ? THROUGH : null, ttl: 0 });
    for (const row of buildFeatureRows(games).rows) {
      const logistic = logisticPicks.get(row.gamePk);
      if (!logistic || !row.fullGameSimulation) continue;
      const mc = simulate(row.fullGameSimulation, { simulations: SIMULATIONS, seed: Number(row.gamePk) });
      const logisticHomeProbability = logistic.homeProbability, mcHomeProbability = mc.homeProbability;
      rows.push({ season, date: row.date, gamePk: row.gamePk, homeTeam: row.homeTeam, awayTeam: row.awayTeam, target: row.fullTarget,
        logisticHomeProbability, mcHomeProbability, expectedRuns: row.fullGameSimulation,
        logisticResult: resultAt(logisticHomeProbability, row.fullTarget), mcResult: resultAt(mcHomeProbability, row.fullTarget),
        fixedBlendResult: resultAt(0.5 * logisticHomeProbability + 0.5 * mcHomeProbability, row.fullTarget) });
    }
    console.log(`${season}: ${rows.filter((r) => r.season === season).length}`);
  }
  const adaptiveRows = [];
  const weights = [];
  for (let season = START + 1; season <= END; season++) {
    const prior = rows.filter((r) => r.season < season), current = rows.filter((r) => r.season === season);
    const weight = bestWeight(prior); weights.push({ season, logisticWeight: weight, monteCarloWeight: 1-weight, priorGames: prior.length });
    for (const row of current) adaptiveRows.push({ ...row, adaptiveResult: resultAt(weight * row.logisticHomeProbability + (1-weight) * row.mcHomeProbability, row.target) });
  }
  const report = { generatedAt: new Date().toISOString(), throughDate: THROUGH, simulationsPerGame: SIMULATIONS,
    coverage: 'Every game shared with the full-game logistic walk-forward evaluation; no confidence filtering.',
    logistic: summarize(rows, 'logisticResult'), monteCarlo: summarize(rows, 'mcResult'), fixedHalfBlend: summarize(rows, 'fixedBlendResult'),
    chronologicalAdaptiveBlend: summarize(adaptiveRows, 'adaptiveResult'), adaptiveWeights: weights,
    bySeason: [...new Set(rows.map((r) => r.season))].map((season) => { const r = rows.filter((x) => x.season === season); return { season, logistic: summarize(r,'logisticResult'), monteCarlo:summarize(r,'mcResult'), fixedHalfBlend:summarize(r,'fixedBlendResult') }; }) };
  fs.writeFileSync(path.join(process.cwd(), 'data/full-game-monte-carlo-backtest.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(process.cwd(), 'data/full-game-monte-carlo-picks.json'), JSON.stringify(rows));
  console.log(JSON.stringify({ logistic: report.logistic, monteCarlo: report.monteCarlo, fixedHalfBlend: report.fixedHalfBlend, chronologicalAdaptiveBlend: report.chronologicalAdaptiveBlend }, null, 2));
}
main().catch((error) => { console.error(error); process.exit(1); });
