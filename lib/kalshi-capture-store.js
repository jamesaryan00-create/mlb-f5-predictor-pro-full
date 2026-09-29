// Reads the most recent CAPTURED Kalshi quote per game from disk (data/kalshi-forward-fullgame/
// and data/kalshi-forward/ capture-*.json files written every ~20 minutes by the droplet's cron --
// see scripts/kalshi-forward.js / scripts/kalshi-forward-fullgame.js), instead of live-fetching
// from Kalshi's API on every request.
//
// Why: FEATURE-WISHLIST.md #41 made the live Kalshi price the primary pick, which required
// lib/mlb.js's getLiveKalshiQuotesForGames() to live-fetch on every /api/predictions request
// (paginate Kalshi's full market list, then per-ticker candlestick fetch with 429 retry/backoff).
// That works fine on the droplet (a long-running process, no time limit) but Vercel serverless
// functions have a hard execution timeout (10s on the Hobby plan). Confirmed live: the droplet and
// the deployed site checked at nearly the same second for the same game (Houston Astros, 2026-09-29
// ~18:16 UTC) gave different results -- droplet available (Astros 53.5%), site unavailable ("no
// live Kalshi price") -- because the live fetch chain didn't finish before Vercel's timeout cut it
// off. Reading the most recent already-captured quote from disk (already bundled into the Vercel
// deployment as committed data/ files, auto-synced from the droplet every ~20 min) is fast and has
// no timeout risk.
//
// This does NOT replace live-fetching in general -- scripts/kalshi-forward.js/-fullgame.js (the
// droplet's cron capture jobs) and pages/kalshi.js (the live board view) still call
// lib/kalshi-board.js / lib/kalshi-board-fullgame.js's getLiveMarkets()/getKalshiQuoteRows()
// directly and unchanged. This module only serves the request-time primary-pick path.
const fs = require('fs'), path = require('path');

// A capture cadence of ~20 minutes means a "current" quote is legitimately anywhere from a few
// seconds to ~20 minutes old at any given moment, even under normal operation -- much wider than
// the 5-minute freshness window kalshi-board.js/kalshi-board-fullgame.js use for a live quote
// (those poll-and-use-immediately, so 5 minutes catches real staleness). 45 minutes gives roughly
// two missed capture cycles of slack (e.g. one delayed cron run, or the tail end of the site
// deploying data slightly behind the droplet) before treating a quote as too old to be a fair
// "primary pick," while still rejecting anything that's clearly from an earlier part of the day.
const MAX_CAPTURE_AGE_MINUTES = 45;

function readCaptureRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^capture-.*\.json$/.test(f));
  const records = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    // `allRecords` (added alongside this module, #42) holds every pregame game with a usable
    // quote for the whole day, not just marketTrust's own <=60-minutes-before-first-pitch window
    // -- that's `records`, which is what this module used to (wrongly) read, making the live pick
    // "unavailable" for any game more than an hour from first pitch. Fall back to `records` only
    // for capture files written before this fix existed, so already-committed history still reads.
    for (const r of j.allRecords || j.records || []) {
      if (!r || r.gamePk == null) continue;
      const capturedAt = r.capturedAt || r.quoteTime || j.capturedAt || j.at;
      if (!capturedAt || !Number.isFinite(Date.parse(capturedAt))) continue;
      records.push({ ...r, capturedAt });
    }
  }
  return records;
}

// Returns a Map<gamePk, record> of the MOST RECENT (by capturedAt) capture per game, excluding
// any capture older than MAX_CAPTURE_AGE_MINUTES relative to `now`. `now` is injectable for tests.
function latestQuoteByGamePk(dir, now = Date.now()) {
  const records = readCaptureRecords(dir);
  const latest = new Map();
  for (const r of records) {
    const prev = latest.get(r.gamePk);
    if (!prev || Date.parse(r.capturedAt) > Date.parse(prev.capturedAt)) latest.set(r.gamePk, r);
  }
  const fresh = new Map();
  for (const [gamePk, r] of latest) {
    const ageMinutes = (now - Date.parse(r.capturedAt)) / 60000;
    if (ageMinutes >= 0 && ageMinutes <= MAX_CAPTURE_AGE_MINUTES) fresh.set(gamePk, r);
  }
  return fresh;
}

module.exports = { readCaptureRecords, latestQuoteByGamePk, MAX_CAPTURE_AGE_MINUTES };
