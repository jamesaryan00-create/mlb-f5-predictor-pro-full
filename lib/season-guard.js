// Shared guard for the forward-tracking cron scripts (scripts/kalshi-forward.js,
// scripts/kalshi-forward-fullgame.js, scripts/model-forward.js). During the true offseason
// (e.g. Nov-Feb) the MLB schedule API returns zero games for a date, but those scripts still
// used to write a small dated file (capture-*.json, picks-*.json, grades-*.json) every 20-30
// minutes anyway -- see FEATURE-WISHLIST.md. `hasGamesOnDate`/`hasAnyGames` let a script check
// the schedule up front and skip writing entirely when there is truly nothing scheduled.
//
// lib/mlb.js's getSchedule() does not filter by gameType, so it already returns postseason
// games (D/L/W/F) alongside regular-season games (R) for a given date -- a genuinely gameless
// day (no entries at all, of any gameType) is what this guard treats as "skip"; a day that has
// games but none of them are eligible/matched/upcoming is a different, already-handled case and
// must NOT be caught by this guard.
const { getSchedule } = require('./mlb');

// Returns true if the MLB schedule API reports at least one game (any gameType) for `date`.
// `scheduleFetcher` is injectable so tests can mock it without touching the network.
async function hasGamesOnDate(date, { scheduleFetcher = getSchedule } = {}) {
  const games = await scheduleFetcher(date);
  return Array.isArray(games) && games.length > 0;
}

// Returns true if ANY of `dates` has at least one scheduled game. Short-circuits on first hit.
async function hasAnyGames(dates, opts = {}) {
  for (const date of dates) {
    if (await hasGamesOnDate(date, opts)) return true;
  }
  return false;
}

// Emits the single JSON-line skip log these scripts use elsewhere, then the caller should exit
// (return/continue) without touching data/ -- this function itself never writes any file.
function logSkip(reason) {
  console.log(JSON.stringify({ at: new Date().toISOString(), skipped: true, reason }));
}

module.exports = { hasGamesOnDate, hasAnyGames, logSkip };
