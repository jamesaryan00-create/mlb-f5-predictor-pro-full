// FEATURE-WISHLIST.md #8: Closing Line Value (CLV) tracking.
//
// For each graded marketTrust pick recorded in data/kalshi-forward*/grades-*.json, CLV compares
// the price on the picked side at the time the pick was recorded (the entry capture, already
// embedded in the grade report row) against the closing price on that same side (the last
// pregame capture from data/kalshi-forward*/capture-*.json, via lib/line-movement.js's chain
// builder). CLV = closingPrice - entryPrice (mid price on the picked side): positive means the
// pick got in at a cheaper price than where the market ultimately closed, the standard
// sports-betting proxy for "got a good number," independent of whether the pick actually won.
//
// This only works for the marketTrust cohort (data/kalshi-forward/, data/kalshi-forward-fullgame/)
// because that is the only place an entry price is actually captured at pick time.
// data/model-forward/picks-<date>.json (the model's own full-game/F5 picks) records no Kalshi
// price at all, so CLV cannot be computed for it from existing data -- see the caller for that
// caveat.
const fs = require('fs'), path = require('path');
const { readCaptureRecords, buildChains, priceFor } = require('./line-movement');

function readLatestGradeReport(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^grades-.*\.json$/.test(f));
  let latest = null, latestTime = -Infinity;
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const t = Date.parse(j.generatedAt);
    if (Number.isFinite(t) && t > latestTime) { latestTime = t; latest = j; }
  }
  return latest;
}

// dir: the capture/grade directory (data/kalshi-forward or data/kalshi-forward-fullgame).
// key: which cohort flag on each grade row to score ('marketTrust' by default).
function computeCLV(dir, { key = 'marketTrust' } = {}) {
  const report = readLatestGradeReport(dir);
  if (!report) return { available: false, n: 0, games: [], warning: 'No grade report found.' };
  const entries = (report.results || []).filter((r) => r[key]);
  if (!entries.length) return { available: true, n: 0, excluded: 0, games: [], avgCLV: null, positiveCount: 0, positivePct: null, note: `No graded ${key} picks yet.` };

  const chains = new Map(buildChains(readCaptureRecords(dir)).map((c) => [c.gamePk, c]));

  const games = entries.map((entry) => {
    const base = { gamePk: entry.gamePk, awayTeam: entry.awayTeam, homeTeam: entry.homeTeam, firstPitchUtc: entry.firstPitchUtc, pickSide: entry.kalshiPickSide, pickTeam: entry.kalshiPickTeam, status: entry.status };
    const side = entry.kalshiPickSide;
    if (side !== 'HOME' && side !== 'AWAY') return { ...base, included: false, reason: 'No usable pick side recorded' };
    const sideKey = side === 'HOME' ? 'home' : 'away';
    const entryPrice = priceFor(entry, sideKey);
    const chain = chains.get(entry.gamePk);
    if (!chain || chain.quotes.length < 1) return { ...base, included: false, reason: 'No capture chain found for this game' };
    const closing = chain.quotes[chain.quotes.length - 1];
    if (chain.quotes.length < 2 || closing.capturedAt === entry.capturedAt) {
      return { ...base, included: false, reason: 'Only one capture exists for this game -- no distinct closing price' };
    }
    const closingPrice = priceFor(closing, sideKey);
    if (entryPrice == null || closingPrice == null) return { ...base, included: false, reason: 'Missing quote data for the picked side' };
    if (entry.status !== 'graded') return { ...base, included: false, reason: `Pick not yet graded (status: ${entry.status})` };
    const clv = closingPrice - entryPrice;
    return { ...base, included: true, entryPrice, closingPrice, entryAt: entry.capturedAt, closingAt: closing.capturedAt, clv, positive: clv > 0, win: Boolean(entry.win) };
  }).sort((a, b) => Date.parse(b.firstPitchUtc || 0) - Date.parse(a.firstPitchUtc || 0));

  const included = games.filter((g) => g.included);
  const n = included.length;
  const avgCLV = n ? included.reduce((s, g) => s + g.clv, 0) / n : null;
  const positiveCount = included.filter((g) => g.positive).length;
  const positivePct = n ? 100 * positiveCount / n : null;
  const withPositive = included.filter((g) => g.positive);
  const withNonPositive = included.filter((g) => !g.positive);
  const winRateGivenPositiveCLV = withPositive.length ? 100 * withPositive.filter((g) => g.win).length / withPositive.length : null;
  const winRateGivenNonPositiveCLV = withNonPositive.length ? 100 * withNonPositive.filter((g) => g.win).length / withNonPositive.length : null;

  return {
    available: true,
    n,
    excluded: games.length - n,
    avgCLV,
    positiveCount,
    positivePct,
    positiveCLVSampleSize: withPositive.length,
    nonPositiveCLVSampleSize: withNonPositive.length,
    winRateGivenPositiveCLV,
    winRateGivenNonPositiveCLV,
    games,
    note: 'CLV = closing price minus entry price (mid price on the picked side). Positive means the pick got a cheaper price than where the market closed -- the standard proxy for "got a good number," independent of the actual game result. Sample size is small (a few weeks of tracking); treat the win-rate-by-CLV split as suggestive, not confirmatory.',
  };
}

module.exports = { computeCLV, readLatestGradeReport };
