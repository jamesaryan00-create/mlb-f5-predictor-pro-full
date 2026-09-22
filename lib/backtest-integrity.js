const { PIPELINE_VERSION } = require('./mlb');

function validateBacktest(results, picks) {
  if (results?.pipelineVersion !== PIPELINE_VERSION) throw new Error('Backtest requires corrected historical pipeline');
  if (!Array.isArray(picks) || !picks.length) throw new Error('Supporting picks unavailable');
  const ids = new Set(), counts = { picks: picks.length, wins: 0, losses: 0, pushes: 0 };
  let loss = 0, brier = 0;
  for (const row of picks) {
    if (!Number.isSafeInteger(row.gamePk) || ids.has(row.gamePk)) throw new Error('Duplicate or invalid evaluation game ID');
    ids.add(row.gamePk);
    if (![row.homeF5,row.awayF5].every((v) => Number.isInteger(v) && v >= 0)) throw new Error('Invalid F5 result');
    const p = row.homeProbability;
    if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new Error('Invalid model probability');
    const side = p >= .5 ? 'home' : 'away';
    const actual = row.homeF5 === row.awayF5 ? 'push' : (row.homeF5 > row.awayF5 ? 'home' : 'away');
    const result = actual === 'push' ? 'push' : actual === side ? 'win' : 'loss';
    if (row.side !== side || row.result !== result) throw new Error('Prediction grading mismatch');
    counts[result === 'push' ? 'pushes' : result === 'win' ? 'wins' : 'losses']++;
    if (result !== 'push') { const y = actual === 'home' ? 1 : 0; loss -= y*Math.log(p)+(1-y)*Math.log(1-p); brier += (p-y)**2; }
  }
  for (const key of Object.keys(counts)) if (results.overall?.[key] !== counts[key]) throw new Error(`Backtest ${key} mismatch`);
  const decided = counts.wins + counts.losses;
  if (!decided) throw new Error('No decided evaluation games');
  const winPct = Number((100 * counts.wins / counts.picks).toFixed(2));
  if (results.overall.winPct !== winPct) throw new Error('Backtest win percentage mismatch');
  return { ...counts, uniqueGames: ids.size, winPct, logLoss: loss/decided, brier: brier/decided };
}
module.exports = { validateBacktest };
