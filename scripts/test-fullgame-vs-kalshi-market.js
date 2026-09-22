// Head-to-head test: full-game model (data/full-game-model.json predictions, as captured in
// data/full-game-backtest-picks.json) vs. real KXMLBGAME (Kalshi full-game moneyline) market
// prices, following the same methodology as the F5 vs. KXMLBF5 comparison in FEATURE-WISHLIST.md
// item #18: reconstruct the latest completed pregame 1-minute candle strictly before scheduled
// first pitch for each side, require a fresh/synchronized/tight-spread quote set, then compare
// log loss / Brier / decided-game accuracy for Kalshi alone, the model alone, and a 50/50 blend.
//
// KXMLBGAME is 2-way (HOME/AWAY only, no TIE contract -- extra innings force a winner), so the
// TIE handling from reconstruct-kalshi.js / kalshi-board.js is dropped, but the rate-limit
// handling (getJson retry/backoff, mapWithConcurrency pacing) and candlestick quality-filter
// logic (selectLatestQuote, MAX_SPREAD) are reused as-is from lib/kalshi-quotes.js.
//
// Read-only: GET requests to Kalshi's public market-data API and MLB's public schedule API.
// Does not modify lib/full-game-model.js, lib/mlb.js, or any other pipeline code.

const fs = require('fs');
const path = require('path');
const { selectLatestQuote } = require('../lib/kalshi-quotes');

const BASE = 'https://external-api.kalshi.com/trade-api/v2';
const SERIES = 'KXMLBGAME';
const MAX_SPREAD = 0.15;
const MAX_QUOTE_AGE_MINUTES = 5;
const MAX_QUOTE_SKEW_MINUTES = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'mlb-fullgame-vs-kalshi/1.0' },
      signal: AbortSignal.timeout(15000)
    });
    if (r.status === 429 && attempt < retries) {
      const retryAfterSeconds = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 750 * 2 ** attempt;
      await sleep(waitMs);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
    return r.json();
  }
}

async function mapWithConcurrency(items, limit, fn, staggerMs = 500) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      if (i > 0) await sleep(staggerMs);
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Same team map used by lib/kalshi-board.js's parseEvent, reproduced locally so this script
// doesn't need to touch/extend that lib file for the extra "G1"/"G2" doubleheader suffix
// KXMLBGAME event tickers can carry (e.g. KXMLBGAME-26SEP221305TBNYYG1).
const TEAM_MAP = {
  AZ: 'Arizona Diamondbacks', ATL: 'Atlanta Braves', BAL: 'Baltimore Orioles', BOS: 'Boston Red Sox',
  CHC: 'Chicago Cubs', CWS: 'Chicago White Sox', CIN: 'Cincinnati Reds', CLE: 'Cleveland Guardians',
  COL: 'Colorado Rockies', DET: 'Detroit Tigers', HOU: 'Houston Astros', KC: 'Kansas City Royals',
  LAA: 'Los Angeles Angels', LAD: 'Los Angeles Dodgers', MIA: 'Miami Marlins', MIL: 'Milwaukee Brewers',
  MIN: 'Minnesota Twins', NYM: 'New York Mets', NYY: 'New York Yankees', ATH: 'Athletics', OAK: 'Athletics',
  PHI: 'Philadelphia Phillies', PIT: 'Pittsburgh Pirates', SD: 'San Diego Padres', SEA: 'Seattle Mariners',
  SF: 'San Francisco Giants', STL: 'St. Louis Cardinals', TB: 'Tampa Bay Rays', TEX: 'Texas Rangers',
  TOR: 'Toronto Blue Jays', WSH: 'Washington Nationals'
};
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const ALIASES = Object.keys(TEAM_MAP).sort((a, b) => b.length - a.length);

function normTeam(value) {
  let x = String(value || '').toLowerCase().replace(/[.,'’\-]/g, '').replace(/\s+/g, ' ').trim();
  if (x === 'oakland athletics') x = 'athletics';
  return x;
}

function parseEvent(eventTicker) {
  const tail = String(eventTicker || '').split('-').pop().replace(/G\d$/, '');
  const m = tail.match(/^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)$/);
  if (!m) return null;
  const [, yy, mon, dd, hh, mm, blob] = m;
  let awayCode = null, homeCode = null;
  for (const away of ALIASES) {
    if (!blob.startsWith(away)) continue;
    const home = blob.slice(away.length);
    if (TEAM_MAP[home]) { awayCode = away; homeCode = home; break; }
  }
  if (!awayCode || !homeCode || !MONTHS[mon]) return null;
  return { date: `20${yy}-${MONTHS[mon]}-${dd}`, awayCode, homeCode, awayTeam: TEAM_MAP[awayCode], homeTeam: TEAM_MAP[homeCode] };
}

async function getAllMarkets(status) {
  const markets = [];
  let cursor = null;
  while (true) {
    const params = new URLSearchParams({ series_ticker: SERIES, limit: '1000' });
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    const data = await getJson(`${BASE}/markets?${params.toString()}`);
    markets.push(...(data.markets || []));
    cursor = data.cursor;
    if (!cursor) break;
  }
  return markets;
}

// MLB schedule for a date range, used to resolve gamePk/firstPitchUtc for each matched event.
async function getSchedule(startDate, endDate) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}`;
  const data = await getJson(url);
  const rows = [];
  for (const dateBlock of data.dates || []) {
    for (const g of dateBlock.games || []) {
      if (g.gameType && g.gameType !== 'R' && g.gameType !== 'F' && g.gameType !== 'D' && g.gameType !== 'L' && g.gameType !== 'W') continue;
      const away = g?.teams?.away?.team?.name;
      const home = g?.teams?.home?.team?.name;
      rows.push({
        gamePk: g.gamePk,
        homeId: g.teams?.home?.team?.id,
        awayId: g.teams?.away?.team?.id,
        awayTeam: away,
        homeTeam: home,
        awayNorm: normTeam(away),
        homeNorm: normTeam(home),
        officialDate: g.officialDate,
        firstPitchUtc: g.gameDate,
        status: g?.status?.detailedState || null
      });
    }
  }
  return rows;
}

// 2-way analogue of lib/kalshi-quotes.js's quoteSetQuality (which requires exactly 3 quotes).
function quoteSetQuality2(quotes, now) {
  const times = quotes.map((q) => Date.parse(q?.time));
  if (times.length !== 2 || times.some((t) => !Number.isFinite(t))) return { available: false, reason: 'Incomplete quote set' };
  const oldest = Math.min(...times), newest = Math.max(...times);
  const age = (Number(now) - oldest) / 60000;
  if (age < 0 || age > MAX_QUOTE_AGE_MINUTES) return { available: false, reason: 'Quote set is stale or future-dated' };
  if ((newest - oldest) / 60000 > MAX_QUOTE_SKEW_MINUTES) return { available: false, reason: 'Outcome quote timestamps are not synchronized' };
  return { available: true, quoteTime: new Date(oldest).toISOString(), quoteAgeMinutes: age, quoteSkewMinutes: (newest - oldest) / 60000 };
}

async function fetchCandleQuote(ticker, firstPitchUtc) {
  const start = Date.parse(firstPitchUtc);
  const cutoff = start - 1000;
  const windowStart = cutoff - 6 * 60 * 60 * 1000;
  const params = new URLSearchParams({
    start_ts: String(Math.floor(windowStart / 1000)),
    end_ts: String(Math.floor(cutoff / 1000)),
    period_interval: '1'
  });
  const url = `${BASE}/series/${SERIES}/markets/${encodeURIComponent(ticker)}/candlesticks?${params}`;
  let data;
  try {
    data = await getJson(url);
  } catch (error) {
    return { quote: null, reason: `Quote request failed: ${error.message}` };
  }
  return selectLatestQuote(data.candlesticks, firstPitchUtc, cutoff, MAX_SPREAD);
}

// --- stats helpers ---
function logLoss(pHome, homeWon) {
  const p = Math.min(Math.max(pHome, 1e-9), 1 - 1e-9);
  return homeWon ? -Math.log(p) : -Math.log(1 - p);
}
function brier(pHome, homeWon) {
  const outcome = homeWon ? 1 : 0;
  return (pHome - outcome) ** 2;
}
function accuracy(pHome, homeWon) {
  const pickedHome = pHome >= 0.5;
  return pickedHome === homeWon ? 1 : 0;
}
function summarizeMetric(rows, probKey) {
  const n = rows.length;
  const ll = rows.reduce((s, r) => s + logLoss(r[probKey], r.homeWon), 0) / n;
  const br = rows.reduce((s, r) => s + brier(r[probKey], r.homeWon), 0) / n;
  const acc = rows.reduce((s, r) => s + accuracy(r[probKey], r.homeWon), 0) / n;
  return { n, logLoss: ll, brier: br, accuracy: acc * 100 };
}
function bootstrapLogLossGap(rows, probKeyA, probKeyB, iterations = 10000) {
  const n = rows.length;
  const gaps = [];
  for (let i = 0; i < iterations; i++) {
    let sumA = 0, sumB = 0;
    for (let k = 0; k < n; k++) {
      const idx = Math.floor(Math.random() * n);
      const r = rows[idx];
      sumA += logLoss(r[probKeyA], r.homeWon);
      sumB += logLoss(r[probKeyB], r.homeWon);
    }
    gaps.push(sumA / n - sumB / n);
  }
  gaps.sort((a, b) => a - b);
  const lo = gaps[Math.floor(0.025 * iterations)];
  const hi = gaps[Math.floor(0.975 * iterations)];
  const mean = gaps.reduce((s, x) => s + x, 0) / iterations;
  return { mean, ci95: [lo, hi] };
}

async function main() {
  const startDate = process.argv[2] || '2026-08-01';
  const endDate = process.argv[3] || '2026-09-21';

  console.error(`Fetching settled KXMLBGAME markets...`);
  const settledMarkets = await getAllMarkets('settled');
  console.error(`Got ${settledMarkets.length} settled markets`);

  const byEvent = new Map();
  for (const m of settledMarkets) {
    if (!m?.event_ticker) continue;
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
    byEvent.get(m.event_ticker).push(m);
  }
  console.error(`${byEvent.size} unique events`);

  console.error(`Fetching MLB schedule ${startDate}..${endDate}...`);
  const schedule = await getSchedule(startDate, endDate);
  console.error(`${schedule.length} scheduled games`);

  const picksPath = path.join(__dirname, '..', 'data', 'full-game-backtest-picks.json');
  const picks = JSON.parse(fs.readFileSync(picksPath, 'utf8'));
  const picksByGamePk = new Map(picks.map((p) => [p.gamePk, p]));
  console.error(`${picks.length} model backtest picks loaded`);

  const candidates = [];
  const rejected = [];

  for (const [eventTicker, eventMarkets] of byEvent) {
    if (eventMarkets.length !== 2) { rejected.push({ eventTicker, reason: `Expected 2 markets, got ${eventMarkets.length}` }); continue; }
    const parsed = parseEvent(eventTicker);
    if (!parsed) { rejected.push({ eventTicker, reason: 'Could not parse event ticker' }); continue; }
    if (parsed.date < startDate || parsed.date > endDate) continue;

    const matches = schedule.filter(
      (g) => g.awayNorm === normTeam(parsed.awayTeam) && g.homeNorm === normTeam(parsed.homeTeam) && g.officialDate === parsed.date
    );
    if (matches.length !== 1) { rejected.push({ eventTicker, reason: `Missing or ambiguous MLB schedule match (${matches.length})` }); continue; }
    const game = matches[0];

    if (!/^(Final|Game Over|Completed Early)/i.test(game.status || '')) { rejected.push({ eventTicker, reason: `Game not final: ${game.status}` }); continue; }

    const marketByOutcome = {};
    for (const m of eventMarkets) {
      const suffix = String(m.ticker || '').split('-').pop();
      if (suffix === parsed.awayCode) marketByOutcome.AWAY = m;
      else if (suffix === parsed.homeCode) marketByOutcome.HOME = m;
    }
    if (!marketByOutcome.AWAY || !marketByOutcome.HOME) { rejected.push({ eventTicker, reason: 'Could not map AWAY/HOME markets' }); continue; }

    const pick = picksByGamePk.get(game.gamePk);
    if (!pick) { rejected.push({ eventTicker, reason: `No model pick for gamePk ${game.gamePk}` }); continue; }

    candidates.push({ eventTicker, parsed, game, markets: marketByOutcome, pick });
  }

  console.error(`${candidates.length} candidates with schedule + model-pick match; fetching candlesticks...`);

  const rows = await mapWithConcurrency(candidates, 2, async (item) => {
    const { eventTicker, game, markets, pick, parsed } = item;
    const [awayR, homeR] = await Promise.all([
      fetchCandleQuote(markets.AWAY.ticker, game.firstPitchUtc),
      fetchCandleQuote(markets.HOME.ticker, game.firstPitchUtc)
    ]);
    if (!awayR.quote || !homeR.quote) {
      rejected.push({ eventTicker, reason: [awayR.reason, homeR.reason].filter(Boolean).join('; ') });
      return null;
    }
    const quality = quoteSetQuality2([awayR.quote, homeR.quote], Date.parse(game.firstPitchUtc) - 1000);
    if (!quality.available) { rejected.push({ eventTicker, reason: quality.reason }); return null; }

    const away = awayR.quote.mid, home = homeR.quote.mid;
    const sum = away + home;
    if (!(sum > 0)) { rejected.push({ eventTicker, reason: 'Non-positive quote sum' }); return null; }
    const kalshiHomeProb = home / sum;

    const modelHomeProb = pick.homeProbability;
    if (!Number.isFinite(modelHomeProb)) { rejected.push({ eventTicker, reason: 'Model probability missing' }); return null; }

    const homeWon = game.homeId != null && pick.homeFinal != null && pick.awayFinal != null
      ? pick.homeFinal > pick.awayFinal
      : null;
    if (homeWon === null) { rejected.push({ eventTicker, reason: 'Could not determine outcome' }); return null; }
    if (pick.homeFinal === pick.awayFinal) { rejected.push({ eventTicker, reason: 'Tied final score (unexpected for full game)' }); return null; }

    return {
      eventTicker,
      gamePk: game.gamePk,
      date: game.officialDate,
      awayTeam: parsed.awayTeam,
      homeTeam: game.homeTeam,
      firstPitchUtc: game.firstPitchUtc,
      kalshiHomeProb,
      modelHomeProb,
      blendHomeProb: 0.5 * kalshiHomeProb + 0.5 * modelHomeProb,
      homeWon,
      quoteTime: quality.quoteTime,
      awaySpread: awayR.quote.spread,
      homeSpread: homeR.quote.spread
    };
  });

  const matched = rows.filter(Boolean);

  console.error(`${matched.length} clean matched games after quality filters`);

  if (matched.length < 100) {
    console.error(`WARNING: sample size ${matched.length} is under the ~100 game threshold for a meaningful comparison.`);
  }

  const kalshiMetrics = summarizeMetric(matched, 'kalshiHomeProb');
  const modelMetrics = summarizeMetric(matched, 'modelHomeProb');
  const blendMetrics = summarizeMetric(matched, 'blendHomeProb');

  const bootstrapKalshiVsModel = bootstrapLogLossGap(matched, 'kalshiHomeProb', 'modelHomeProb');
  const bootstrapKalshiVsBlend = bootstrapLogLossGap(matched, 'kalshiHomeProb', 'blendHomeProb');
  const bootstrapModelVsBlend = bootstrapLogLossGap(matched, 'modelHomeProb', 'blendHomeProb');

  const dates = matched.map((r) => r.date).sort();

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'Latest completed one-minute KXMLBGAME candle strictly before scheduled first pitch for both AWAY and HOME markets; quotes within 5 minutes of now-at-cutoff and 1 minute of each other; max spread 0.15. 2-way (no TIE contract). Reconstructed from Kalshi public candlestick history, not live or executed.',
    seriesLaunchWindow: { earliestSettledEvent: 'see rejected/candidates log; queried status=settled markets', requestedRange: [startDate, endDate] },
    counts: {
      settledMarkets: settledMarkets.length,
      uniqueEvents: byEvent.size,
      candidatesWithScheduleAndModelMatch: candidates.length,
      cleanMatchedGames: matched.length,
      rejected: rejected.length
    },
    dateRangeOfMatchedGames: matched.length ? [dates[0], dates[dates.length - 1]] : null,
    metrics: { kalshi: kalshiMetrics, model: modelMetrics, blend: blendMetrics },
    bootstrap: {
      iterations: 10000,
      kalshiMinusModelLogLossGap: bootstrapKalshiVsModel,
      kalshiMinusBlendLogLossGap: bootstrapKalshiVsBlend,
      modelMinusBlendLogLossGap: bootstrapModelVsBlend
    },
    rows: matched,
    rejectedSample: rejected.slice(0, 50)
  };

  const outDir = path.join(__dirname, '..', 'data', 'kalshi-forward');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `fullgame-vs-kalshi-market-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(JSON.stringify({
    outFile,
    counts: report.counts,
    dateRangeOfMatchedGames: report.dateRangeOfMatchedGames,
    metrics: report.metrics,
    bootstrap: report.bootstrap
  }, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
