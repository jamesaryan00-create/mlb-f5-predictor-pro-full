// Full-game analogue of lib/kalshi-forward.js: capture()/grade()/summarize() for the KXMLBGAME
// marketTrust cohort. Grading is simpler than F5's -- extra innings always produce a winner, so
// there is no tie outcome to detect or reconcile.
const { quoteSetQuality2 } = require('./kalshi-quotes');

function capture(row, at) {
  const now = Date.parse(at), start = Date.parse(row.firstPitchUtc);
  if (!Number.isFinite(now) || !Number.isFinite(start) || start <= now || !['Scheduled', 'Pre-Game'].includes(row.gameStatus)) return null;
  const qs = ['away', 'home'].map((s) => row.outcomeQuotes?.[s]);
  if (!quoteSetQuality2(qs, now).available || qs.some((q) => !Number.isFinite(q?.mid) || q.mid <= 0 || q.mid >= 1)) return null;
  const home = qs[1].mid / (qs[0].mid + qs[1].mid), confidence = Math.max(home, 1 - home);
  const kalshiPickSide = home >= .5 ? 'HOME' : 'AWAY';
  const modelAgrees = row.modelAvailable && row.modelPickSide === kalshiPickSide;
  const maxSpread = Math.max(qs[0].spread, qs[1].spread);
  // marketTrust rule matches lib/kalshi-forward.js's F5 definition (model agrees with a confident
  // Kalshi price, model itself confident) -- see data/kalshi-forward-fullgame/model-agreement-plan.json.
  const marketTrust = Boolean(modelAgrees && confidence >= .62 && Number(row.modelConfidence) >= .55);
  return { ...row, capturedAt: at, kalshiConfidence: confidence, kalshiPickSide, baseline: confidence >= .58, candidate: confidence >= .62, modelAvailable: Boolean(row.modelAvailable), modelPickSide: row.modelPickSide ?? null, modelConfidence: row.modelConfidence ?? null, modelAgreesWithKalshi: row.modelAvailable ? modelAgrees : null, maxSpread, marketTrust };
}

// No tie case: the full-game market always resolves HOME or AWAY, so grading only needs final
// score comparison, not firstFiveRuns.
function grade(r, g) {
  if (g?.gamePk !== r.gamePk || g.teams?.home?.team?.id !== r.homeId || g.teams?.away?.team?.id !== r.awayId) return { status: 'excluded', reason: 'Identity mismatch' };
  if (g.officialDate !== r.officialDate || Date.parse(g.gameDate) !== Date.parse(r.firstPitchUtc) || Object.keys(g).some((k) => /^resum/i.test(k) && g[k])) return { status: 'excluded', reason: 'Changed schedule or resumed game' };
  if (!/^(Final|Game Over|Completed Early)(:|$)/.test(g.status?.detailedState || '')) return { status: 'pending' };
  const home = Number(g.linescore?.teams?.home?.runs), away = Number(g.linescore?.teams?.away?.runs);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return { status: 'excluded', reason: 'Incomplete final score' };
  if (home === away) return { status: 'excluded', reason: 'Tied final score (unexpected for full game)' };
  const result = home > away ? 'HOME' : 'AWAY';
  return { status: 'graded', home, away, result, win: result === r.kalshiPickSide, tie: false };
}

function summarize(rows, key) {
  const selected = rows.filter((r) => r[key]), graded = selected.filter((r) => r.status === 'graded');
  const wins = graded.filter((r) => r.win).length;
  return { selected: selected.length, graded: graded.length, wins, losses: graded.length - wins, pending: selected.filter((r) => r.status === 'pending').length, excluded: selected.filter((r) => r.status === 'excluded').length, winPct: graded.length ? 100 * wins / graded.length : null };
}

module.exports = { capture, grade, summarize };
