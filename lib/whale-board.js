// Aggregates the per-record whaleActivity captured by scripts/kalshi-forward.js /
// scripts/kalshi-forward-fullgame.js (see lib/whale-trades.js) into a small per-game board for the
// UI/API. Same capture-file-reading convention as lib/line-movement.js: reads every
// capture-*.json in the given directory (data/kalshi-forward or data/kalshi-forward-fullgame) and
// keeps the most recent snapshot per game, since trade activity accumulates over the pregame
// window and later captures see strictly more trades than earlier ones.
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

function summarizeWhaleBoard(dir) {
  const records = readCaptureRecords(dir).filter((r) => r.whaleActivity && !r.whaleActivity.error);
  if (!records.length) return { available: false, n: 0, games: [], warning: 'No whale-trade data captured yet.' };

  const latestByGame = new Map();
  for (const r of records) {
    const prev = latestByGame.get(r.gamePk);
    if (!prev || Date.parse(r.capturedAt) > Date.parse(prev.capturedAt)) latestByGame.set(r.gamePk, r);
  }

  const games = [...latestByGame.values()].map((r) => {
    const wa = r.whaleActivity;
    const sides = Object.values(wa.bySide || {}).filter((s) => s && s.available);
    const largestDollars = sides.length ? Math.max(...sides.map((s) => s.largestDollars || 0)) : null;
    const totalDollars = sides.reduce((s, side) => s + (side.totalDollars || 0), 0);
    const blockTradeCount = sides.reduce((s, side) => s + (side.blockTradeCount || 0), 0);
    const largeTradeCount = sides.reduce((s, side) => s + (side.largeTradeCount || 0), 0);
    const largeTradeDollars = sides.reduce((s, side) => s + (side.largeTradeDollars || 0), 0);
    return {
      gamePk: r.gamePk,
      awayTeam: r.awayTeam,
      homeTeam: r.homeTeam,
      pickTeam: r.kalshiPickTeam,
      capturedAt: r.capturedAt,
      firstPitchUtc: r.firstPitchUtc,
      hasTrades: sides.some((s) => s.n > 0),
      largestDollars,
      totalDollars,
      blockTradeCount,
      largeTradeCount,
      largeTradeDollars,
      largeTradeDirectionVsPick: wa.largeTradeDirectionVsPick,
    };
  }).sort((a, b) => Date.parse(b.firstPitchUtc || 0) - Date.parse(a.firstPitchUtc || 0));

  return {
    available: true,
    n: games.length,
    games,
    note: 'NEW, UNPROVEN signal -- exploratory only. This has not been validated against outcomes and does not imply predictive power. Large-trade direction is derived from Kalshi\'s public trade feed (size threshold + Kalshi\'s own is_block_trade flag), not from any confirmed insider or "sharp" activity.',
  };
}

module.exports = { readCaptureRecords, summarizeWhaleBoard };
