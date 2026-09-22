const fs = require('fs');
const path = require('path');
const { fetchSeasonGames } = require('../lib/historical-f5');

async function main() {
  const seasons = [2023, 2024, 2025], counts = { games: 0, homeEarly: 0, awayEarly: 0, homeLate: 0, awayLate: 0, tiedAfterNine: 0, homeExtraWins: 0 };
  for (const season of seasons) {
    for (const game of await fetchSeasonGames(season)) {
      const innings = game.linescore?.innings || [];
      if (![1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => innings.some((i) => i.num === n))) continue;
      const runs = (side, first, last) => innings.filter((i) => i.num >= first && i.num <= last).reduce((sum, i) => sum + Number(i[side]?.runs || 0), 0);
      const homeEarly = runs('home', 1, 5), awayEarly = runs('away', 1, 5);
      const homeLate = runs('home', 6, 9), awayLate = runs('away', 6, 9);
      counts.games++; counts.homeEarly += homeEarly; counts.awayEarly += awayEarly; counts.homeLate += homeLate; counts.awayLate += awayLate;
      if (homeEarly + homeLate === awayEarly + awayLate) { counts.tiedAfterNine++; if (game.teams.home.isWinner) counts.homeExtraWins++; }
    }
  }
  if (counts.games < 5000 || counts.tiedAfterNine < 300) throw new Error('Insufficient calibration games');
  const ratio = (home, away) => ({ home: 2 * home / (home + away), away: 2 * away / (home + away) });
  const artifact = { seasons, counts, earlyFactors: ratio(counts.homeEarly, counts.awayEarly), lateFactors: ratio(counts.homeLate, counts.awayLate), extraInningHomeWinProbability: counts.homeExtraWins / counts.tiedAfterNine, source: 'MLB Stats API completed regular-season game linescores' };
  fs.writeFileSync(path.join(process.cwd(), 'data/full-game-mc-calibration.json'), JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify(artifact));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
