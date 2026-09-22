// Read-only integrity check. Never trains or overwrites model artifacts.
const fs = require('fs');
const path = require('path');
const picks = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/backtest-picks.json'), 'utf8'));
const unique = new Set(picks.map((pick) => String(pick.gamePk)));
console.log(JSON.stringify({ rows: picks.length, uniqueGames: unique.size, duplicateRows: picks.length - unique.size }, null, 2));
if (unique.size !== picks.length) {
  console.error('Backtest invalid: duplicate games. Regenerate only after reviewing historical input integrity.');
  process.exitCode = 1;
}

if (!process.exitCode) {
  const results = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/backtest-results.json'), 'utf8'));
  console.log(require('../lib/backtest-integrity').validateBacktest(results, picks));
}
