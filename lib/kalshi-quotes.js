// Operational freshness limits for one-minute candles; these are not trading tiers.
const MAX_QUOTE_AGE_MINUTES = 5;
const MAX_QUOTE_SKEW_MINUTES = 1;
function number(value) { return value == null || String(value).trim() === '' ? NaN : Number(value); }
function selectLatestQuote(candles, firstPitchUtc, now, maxSpread = 0.15) {
  const start = Date.parse(firstPitchUtc), clock = Number(now);
  const reject = (reason) => ({ quote: null, reason });
  if (!Number.isFinite(start) || !Number.isFinite(clock) || clock >= start) return reject('Game is not upcoming');
  const eligible = (Array.isArray(candles) ? candles : []).filter((c) => {
    const ts = number(c.end_period_ts) * 1000;
    return Number.isFinite(ts) && ts <= clock && ts < start;
  }).sort((a, b) => number(b.end_period_ts) - number(a.end_period_ts));
  if (!eligible.length) return reject('No completed pregame candle');
  // Validate the newest candle, never substitute an older acceptable market.
  const c = eligible[0], timestamp = number(c.end_period_ts) * 1000;
  const bid = number(c?.yes_bid?.close_dollars), ask = number(c?.yes_ask?.close_dollars);
  const ageMinutes = (clock - timestamp) / 60000;
  if (ageMinutes > MAX_QUOTE_AGE_MINUTES) return reject('Latest candle is stale');
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask > 1 || ask <= bid) return reject('Latest candle has invalid bid/ask');
  const spread = ask - bid;
  if (spread > maxSpread + 1e-9) return reject('Latest candle spread exceeds limit');
  return { quote: { time: new Date(timestamp).toISOString(), bid, ask, mid: (bid + ask) / 2, spread, ageMinutes }, reason: null };
}
function quoteSetQuality(quotes, now) {
  const times = quotes.map((q) => Date.parse(q?.time));
  if (times.length !== 3 || times.some((t) => !Number.isFinite(t))) return { available: false, reason: 'Incomplete quote set' };
  const oldest = Math.min(...times), newest = Math.max(...times);
  const age = (Number(now) - oldest) / 60000;
  if (age < 0 || age > MAX_QUOTE_AGE_MINUTES) return { available: false, reason: 'Quote set is stale or future-dated' };
  if ((newest - oldest) / 60000 > MAX_QUOTE_SKEW_MINUTES) return { available: false, reason: 'Outcome quote timestamps are not synchronized' };
  return { available: true, quoteTime: new Date(oldest).toISOString(), quoteAgeMinutes: age, quoteSkewMinutes: (newest - oldest) / 60000 };
}
// 2-way analogue of quoteSetQuality, for markets with no TIE contract (e.g. KXMLBGAME full-game
// moneyline: extra innings always force a winner).
function quoteSetQuality2(quotes, now) {
  const times = quotes.map((q) => Date.parse(q?.time));
  if (times.length !== 2 || times.some((t) => !Number.isFinite(t))) return { available: false, reason: 'Incomplete quote set' };
  const oldest = Math.min(...times), newest = Math.max(...times);
  const age = (Number(now) - oldest) / 60000;
  if (age < 0 || age > MAX_QUOTE_AGE_MINUTES) return { available: false, reason: 'Quote set is stale or future-dated' };
  if ((newest - oldest) / 60000 > MAX_QUOTE_SKEW_MINUTES) return { available: false, reason: 'Outcome quote timestamps are not synchronized' };
  return { available: true, quoteTime: new Date(oldest).toISOString(), quoteAgeMinutes: age, quoteSkewMinutes: (newest - oldest) / 60000 };
}
module.exports = { selectLatestQuote, quoteSetQuality, quoteSetQuality2, MAX_QUOTE_AGE_MINUTES, MAX_QUOTE_SKEW_MINUTES };
