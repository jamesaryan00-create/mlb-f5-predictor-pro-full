// One-off comparison: full-game model alone vs F5 model alone vs the combined "full-game primary,
// F5 flagged when its edge clears the documented margin" strategy from lib/mlb.js.
// Uses the existing walk-forward backtest pick files (no leakage, same methodology as
// data/full-game-backtest.json / data/backtest-results.json), joined on gamePk so all three
// numbers are computed on the exact same set of games.
//
// F5_FLAG_MARGIN_PP mirrors lib/mlb.js's F5_FLAG_MARGIN_PP (see that file for the decideTier()
// precedent). "Combined" picks F5's side instead of full-game's side ONLY when F5 is flagged;
// otherwise it takes the full-game side. This measures what a user who follows the flag would have
// gotten, not a new trained model.
//
// Run: node scripts/backtest-combined-fg-f5.js
const fgPicks = require('../data/full-game-backtest-picks.json');
const f5Picks = require('../data/backtest-picks.json');
const { F5_FLAG_MARGIN_PP } = require('../lib/mlb');

const f5ByGame = new Map(f5Picks.map((p) => [p.gamePk, p]));

// Only games present in both walk-forward backtests, so all three numbers share one sample.
const joined = fgPicks
  .map((fg) => ({ fg, f5: f5ByGame.get(fg.gamePk) }))
  .filter((row) => row.f5 && row.f5.result !== 'push'); // pushes (F5 ties) are excluded, consistent with how F5's own backtest reports ties-excluded accuracy

function grade(rows, pickSideOf) {
  let wins = 0, losses = 0;
  for (const row of rows) {
    const isWin = pickSideOf(row) === 'f5' ? row.f5.result === 'win' : row.fg.result === 'win';
    if (isWin) wins++; else losses++;
  }
  const n = wins + losses;
  return { picks: n, wins, losses, accuracyPct: n ? Number((100 * wins / n).toFixed(2)) : null };
}

const fgOnly = grade(joined, () => 'fg');
const f5Only = grade(joined, () => 'f5');

let flaggedCount = 0;
const combined = grade(joined, (row) => {
  const fgEdge = Math.abs(row.fg.probability * 100 - 50);
  const f5Edge = Math.abs(row.f5.probability - 50);
  const flagged = f5Edge >= fgEdge + F5_FLAG_MARGIN_PP;
  if (flagged) flaggedCount++;
  return flagged ? 'f5' : 'fg';
});

const report = {
  sampleGames: joined.length,
  flagMarginPp: F5_FLAG_MARGIN_PP,
  gamesFlagged: flaggedCount,
  flaggedSharePct: joined.length ? Number((100 * flaggedCount / joined.length).toFixed(2)) : null,
  fullGameAlone: fgOnly,
  f5Alone: f5Only,
  combinedStrategy: combined
};
console.log(JSON.stringify(report, null, 2));
