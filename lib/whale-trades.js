// FEATURE-WISHLIST.md whale/large-trade detection (see dated entry added alongside the #7/#8
// line-movement/CLV capture fix). Exploratory, unproven signal -- see the honesty note in
// summarizeWhaleActivity below and the UI label wired in components/WhaleActivity.js. Reuses
// lib/kalshi-http.js's getJson (429 retry/backoff) rather than a second fetch implementation, same
// convention as lib/kalshi-board.js / lib/kalshi-board-fullgame.js.
const { getJson } = require('./kalshi-http');

const BASE = 'https://external-api.kalshi.com/trade-api/v2';

// Calls GET /trade-api/v2/markets/trades?ticker=<ticker>&limit=N and returns parsed trade
// records. Never throws on a network/HTTP failure -- returns { available: false, reason } so a
// single quiet or briefly-unreachable market can't take down a whole capture cycle.
async function fetchRecentTrades(ticker, { limit = 200, sinceTs } = {}) {
  if (!ticker) return { available: false, reason: 'No ticker provided', trades: [] };
  const params = new URLSearchParams({ ticker, limit: String(limit) });
  if (Number.isFinite(sinceTs)) params.set('min_ts', String(Math.floor(sinceTs)));
  const url = `${BASE}/markets/trades?${params.toString()}`;
  let data;
  try {
    data = await getJson(url);
  } catch (error) {
    return { available: false, reason: `Trades request failed: ${error.message}`, trades: [] };
  }
  const trades = (data.trades || [])
    .map((t) => {
      const size = Number(t.count_fp);
      const yesPriceDollars = Number(t.yes_price_dollars);
      const noPriceDollars = Number(t.no_price_dollars);
      const takerOutcomeSide = t.taker_outcome_side ?? null;
      // A contract pays $1 if it resolves the taker's way, so its notional/dollar size is
      // contracts x the price actually paid on the side that traded -- NOT the raw contract count.
      // Contract count alone is misleading (a 5,000-contract trade at 3 cents is $150, not a
      // "whale"), so this is computed once here and is the primary unit everywhere downstream.
      const price = takerOutcomeSide === 'yes' ? yesPriceDollars : takerOutcomeSide === 'no' ? noPriceDollars : null;
      const dollars = Number.isFinite(size) && Number.isFinite(price) ? size * price : null;
      return {
        tradeId: t.trade_id ?? null,
        ticker,
        size,
        dollars,
        yesPriceDollars,
        noPriceDollars,
        takerSide: t.taker_side ?? null,
        takerOutcomeSide,
        takerBookSide: t.taker_book_side ?? null,
        createdTime: t.created_time ?? null,
        isBlockTrade: Boolean(t.is_block_trade)
      };
    })
    .filter((t) => Number.isFinite(t.size) && t.size > 0 && Number.isFinite(t.dollars));
  return { available: true, trades };
}

// Simple linear-interpolation percentile over an already-sorted ascending array.
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// Threshold choice, documented rather than silently baked in: default to the market's own 95th
// percentile trade DOLLAR size, but never below $1,000 -- a quiet market's 95th percentile might
// only be a few dollars, which isn't a "whale" by any reasonable reading. Dollar size, not raw
// contract count, is the right unit: a 5,000-contract trade at 3 cents is $150, not a whale, while
// a 500-contract trade at 90 cents is $450 -- contract count alone conflates the two. A caller can
// always override with an explicit dollarThreshold (e.g. a fixed cutoff across markets, or a
// threshold computed once for a whole slate instead of per-market).
const MIN_DOLLAR_THRESHOLD = 1000;

function summarizeWhaleActivity(trades, { dollarThreshold } = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return {
      available: false, n: 0, reason: 'No trades observed for this market',
      largestDollars: null, totalDollars: 0, blockTradeCount: 0, blockTradeDollars: 0,
      largeTradeCount: 0, largeTradeDollars: 0, dollarThreshold: null,
      yesDollars: 0, noDollars: 0, netImbalanceDollars: null, direction: null
    };
  }

  const dollarsAsc = trades.map((t) => t.dollars).slice().sort((a, b) => a - b);
  const p95 = percentile(dollarsAsc, 0.95);
  const threshold = Number.isFinite(dollarThreshold) ? dollarThreshold : Math.max(MIN_DOLLAR_THRESHOLD, p95 || 0);

  const largestDollars = dollarsAsc[dollarsAsc.length - 1];
  const totalDollars = trades.reduce((s, t) => s + t.dollars, 0);
  const blockTrades = trades.filter((t) => t.isBlockTrade);
  // A trade counts as "large" if its dollar size clears the threshold OR Kalshi itself flagged it
  // as a block trade -- is_block_trade is a first-class signal (Kalshi's own judgment, which may
  // use information this module doesn't have access to), not just a fallback when our own cutoff
  // misses something.
  const largeTrades = trades.filter((t) => t.dollars >= threshold || t.isBlockTrade);

  let yesDollars = 0, noDollars = 0;
  for (const t of largeTrades) {
    if (t.takerOutcomeSide === 'yes') yesDollars += t.dollars;
    else if (t.takerOutcomeSide === 'no') noDollars += t.dollars;
  }
  const netImbalanceDollars = yesDollars - noDollars;
  const direction = netImbalanceDollars > 0 ? 'yes' : netImbalanceDollars < 0 ? 'no' : null;

  return {
    available: true,
    n: trades.length,
    largestDollars,
    totalDollars,
    blockTradeCount: blockTrades.length,
    blockTradeDollars: blockTrades.reduce((s, t) => s + t.dollars, 0),
    largeTradeCount: largeTrades.length,
    largeTradeDollars: largeTrades.reduce((s, t) => s + t.dollars, 0),
    dollarThreshold: threshold,
    yesDollars,
    noDollars,
    netImbalanceDollars,
    direction
  };
}

// Wiring helper for the capture scripts: fetches trades for a game's away/home markets and
// summarizes whale activity for each, plus whether large trades cluster toward the side the model
// (or Kalshi's own price) picked. Never throws -- a market with no data or a request failure just
// yields available:false for that side, same as the rest of this pipeline's "exclude, don't crash"
// convention (see lib/kalshi-board.js / lib/kalshi-board-fullgame.js).
async function whaleActivityForRecord(record, { limit = 200 } = {}) {
  const tickers = record?.marketTickers || {};
  const sides = Object.keys(tickers);
  const bySide = {};
  for (const side of sides) {
    const { trades } = await fetchRecentTrades(tickers[side], { limit }).catch(() => ({ trades: [] }));
    bySide[side] = summarizeWhaleActivity(trades || []);
  }

  const pickSide = record?.kalshiPickSide === 'HOME' ? 'home' : record?.kalshiPickSide === 'AWAY' ? 'away' : null;
  // "yes" dollars on the picked side's own market count as large trades favoring the pick; "yes"
  // dollars on the *other* side's market count as large trades against it (buying YES on the
  // opponent is directionally the same as buying NO on the pick).
  let dollarsForPick = 0, dollarsAgainstPick = 0;
  for (const side of sides) {
    const s = bySide[side];
    if (!s.available) continue;
    const favorsThisMarket = s.yesDollars, favorsOtherMarket = s.noDollars;
    if (side === pickSide) { dollarsForPick += favorsThisMarket; dollarsAgainstPick += favorsOtherMarket; }
    else { dollarsForPick += favorsOtherMarket; dollarsAgainstPick += favorsThisMarket; }
  }
  const anyAvailable = sides.some((s) => bySide[s]?.available);
  const largeTradeDirectionVsPick = !anyAvailable || !pickSide ? null
    : dollarsForPick === dollarsAgainstPick ? 'neutral'
    : dollarsForPick > dollarsAgainstPick ? 'agrees_with_pick' : 'against_pick';

  return { bySide, pickSide, dollarsForPick, dollarsAgainstPick, largeTradeDirectionVsPick };
}

module.exports = { fetchRecentTrades, summarizeWhaleActivity, whaleActivityForRecord, percentile, MIN_DOLLAR_THRESHOLD };
