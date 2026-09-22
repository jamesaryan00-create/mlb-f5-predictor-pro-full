const fs = require('fs');
const path = require('path');
const { fetchSeasonGames, buildFeatureRows } = require('../lib/historical-f5');
const { simulate, simulateV2 } = require('../lib/full-game-monte-carlo');

async function main() {
  const throughDate = process.env.HISTORY_THROUGH_DATE || '2026-09-21';
  const rows = buildFeatureRows(await fetchSeasonGames(2026, { throughDate })).rows;
  const logistic = new Map(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/full-game-backtest-picks.json'))).filter((p) => p.date.startsWith('2026')).map((p) => [p.gamePk, p]));
  const bullpens = new Map(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/bullpen-quality-history-2010-2026.json'))).filter((p) => p.season === 2026).map((p) => [`${p.gamePk}:${p.side}`, p]));
  const report = { calibrationSeasons: [2023, 2024, 2025], throughDate, games: 0, logisticWins: 0, monteCarloV1Wins: 0, monteCarloV2Wins: 0, completeBullpenGames: 0, completeBullpenV2Wins: 0, simulationsPerGame: 1200 };
  for (const row of rows) {
    const reference = logistic.get(row.gamePk);
    if (!reference) continue;
    const seed = Number(row.gamePk), actual = row.fullTarget;
    const home = bullpens.get(`${row.gamePk}:HOME`), away = bullpens.get(`${row.gamePk}:AWAY`);
    const v1 = simulate(row.fullGameSimulation, { simulations: 1200, seed });
    const v2 = simulateV2(row.fullGameSimulation, { home, away }, { simulations: 1200, seed, bullpenStrength: .25 });
    report.games++;
    report.logisticWins += Number((reference.homeProbability >= .5 ? 1 : 0) === actual);
    report.monteCarloV1Wins += Number((v1.homeProbability >= .5 ? 1 : 0) === actual);
    report.monteCarloV2Wins += Number((v2.homeProbability >= .5 ? 1 : 0) === actual);
    if (home?.available && away?.available) { report.completeBullpenGames++; report.completeBullpenV2Wins += Number((v2.homeProbability >= .5 ? 1 : 0) === actual); }
  }
  fs.writeFileSync(path.join(process.cwd(), 'data/full-game-mc-2026-holdout.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
