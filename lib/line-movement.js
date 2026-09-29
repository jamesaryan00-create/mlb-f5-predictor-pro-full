// FEATURE-WISHLIST.md #7: line movement on Kalshi's own captured price history.
//
// The forward-capture pipelines (lib/kalshi-forward.js / lib/kalshi-forward-fullgame.js, cron-run
// every 20 minutes on the droplet) already write timestamped quote snapshots to
// data/kalshi-forward/capture-*.json and data/kalshi-forward-fullgame/capture-*.json. Each
// capture-*.json's `records` array holds one row per qualifying game with a full
// `outcomeQuotes` object (bid/ask/mid/spread per side) plus `capturedAt`. This module chains
// those records together per game and reports opening vs closing price on the side the model
// picked.
//
// Honesty note (see FEATURE-WISHLIST.md #7): Kalshi does not expose a volume/bet-count
// breakdown, so there is no way to detect true "reverse line movement" (price moving against
// the side taking the most money) from what's captured here. This only measures whether the
// price on the model's picked side rose or fell between the first and last pregame capture --
// labeled plainly as "net movement", not "sharp money" or "RLM".
const fs = require('fs'), path = require('path');

function readCaptureRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^capture-.*\.json$/.test(f));
  const records = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const r of j.records || []) if (r && r.gamePk != null && r.capturedAt) records.push(r);
  }
  return records;
}

// Groups raw capture records by gamePk into a sorted, de-duplicated quote chain per game.
function buildChains(records) {
  const byGame = new Map();
  for (const r of records) {
    if (!byGame.has(r.gamePk)) byGame.set(r.gamePk, []);
    byGame.get(r.gamePk).push(r);
  }
  const chains = [];
  for (const [gamePk, list] of byGame) {
    const seenAt = new Set();
    const quotes = list
      .filter((r) => { if (seenAt.has(r.capturedAt)) return false; seenAt.add(r.capturedAt); return true; })
      .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    const last = quotes[quotes.length - 1];
    chains.push({ gamePk, awayTeam: last.awayTeam, homeTeam: last.homeTeam, firstPitchUtc: last.firstPitchUtc, quotes });
  }
  return chains;
}

function priceFor(record, sideKey) {
  const q = record.outcomeQuotes && record.outcomeQuotes[sideKey];
  return q && Number.isFinite(q.mid) ? q.mid : null;
}

// Computes opening/closing price and net movement for one game's quote chain, on the side
// named by `sideField` ('modelPickSide' by default; 'kalshiPickSide' is the other valid option).
// Returns { included: false, reason } for anything too sparse or ambiguous to measure honestly.
function movementForChain(chain, { sideField = 'modelPickSide' } = {}) {
  const { gamePk, awayTeam, homeTeam, firstPitchUtc, quotes } = chain;
  const base = { gamePk, awayTeam, homeTeam, firstPitchUtc };
  if (quotes.length < 2) {
    return { ...base, included: false, reason: `Only ${quotes.length} capture${quotes.length === 1 ? '' : 's'} before first pitch -- not enough to measure movement` };
  }
  const closing = quotes[quotes.length - 1];
  const side = closing[sideField];
  if (side !== 'HOME' && side !== 'AWAY') {
    return { ...base, included: false, reason: 'No usable pick side on the closing capture (model unavailable)' };
  }
  const sideKey = side === 'HOME' ? 'home' : 'away';
  const opening = quotes[0];
  const openingPrice = priceFor(opening, sideKey);
  const closingPrice = priceFor(closing, sideKey);
  if (openingPrice == null || closingPrice == null) {
    return { ...base, included: false, reason: 'Missing quote data for the picked side' };
  }
  const netMovement = closingPrice - openingPrice;
  return {
    ...base,
    included: true,
    pickSide: side,
    pickTeam: side === 'HOME' ? homeTeam : awayTeam,
    captureCount: quotes.length,
    openingAt: opening.capturedAt,
    closingAt: closing.capturedAt,
    openingPrice,
    closingPrice,
    netMovement,
    movedAway: netMovement < 0,
    movedToward: netMovement > 0,
  };
}

// dir: the capture directory (data/kalshi-forward or data/kalshi-forward-fullgame).
function summarizeLineMovement(dir, opts = {}) {
  const records = readCaptureRecords(dir);
  if (!records.length) return { available: false, n: 0, games: [], warning: 'No capture data found.' };
  const chains = buildChains(records);
  const games = chains
    .map((c) => movementForChain(c, opts))
    .sort((a, b) => Date.parse(b.firstPitchUtc || 0) - Date.parse(a.firstPitchUtc || 0));
  const included = games.filter((g) => g.included);
  const n = included.length;
  const avgMovement = n ? included.reduce((s, g) => s + g.netMovement, 0) / n : null;
  const movedAwayCount = included.filter((g) => g.movedAway).length;
  const movedTowardCount = included.filter((g) => g.movedToward).length;
  return {
    available: true,
    n,
    excluded: games.length - n,
    avgMovement,
    movedAwayCount,
    movedTowardCount,
    movedAwayPct: n ? 100 * movedAwayCount / n : null,
    games,
    note: 'Movement is opening-vs-closing price on the side the model picked, using each capture\'s mid price. This is the honest, simpler version of line movement -- Kalshi does not publish a volume/bet-count breakdown, so this cannot show true reverse line movement (price moving against the side taking the most money). "Moved away" just means the price on the picked side fell between the first and last pregame capture; treat it as an observation, not a sharp-money signal.',
  };
}

module.exports = { readCaptureRecords, buildChains, movementForChain, summarizeLineMovement, priceFor };
